'use strict'
/**
 * Notification inbox source: reads the toast notifications Windows itself stores for every app
 * (%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db), so the widget can show a badge count
 * and an inbox of what you got. Read-only, local, no admin rights, nothing is sent anywhere.
 * The database is locked by Windows, so each poll reads a private copy (only when the files changed).
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FILETIME_EPOCH_MS = 11644473600000
const POLL_MS = 4000
const BACKFILL_MS = 12 * 3600 * 1000
const BACKFILL_MAX = 20

// ------------------------------------------------------------ pure helpers (unit-tested)
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENT[e.toLowerCase()] ?? ''
  })
}

/** toast XML (Buffer or string) → {title, body}; returns null if there is nothing readable */
function parseToast(payload) {
  let xml = payload
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    const b = Buffer.from(payload)
    xml = b.length > 1 && b[1] === 0 ? b.toString('utf16le') : b.toString('utf8')
  }
  xml = String(xml).replace(/^﻿/, '')
  const texts = []
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>/gi
  let m
  while ((m = re.exec(xml))) {
    const t = decodeXml(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
    if (t) texts.push(t)
  }
  if (!texts.length) return null
  return { title: texts[0].slice(0, 120), body: texts.slice(1).join(' ').slice(0, 300) }
}

const GENERIC = /^(app|exe|microsoft|windows|com|org|net|io|www|desktop|client|application)$/i

const KNOWN = [
  [/immersivecontrolpanel/i, 'Settings'],
  [/^\{[0-9a-f-]{36}\}$/i, 'System'],
  [/windowscommunicationsapps.*mail/i, 'Mail'],
  [/windowscommunicationsapps.*calendar/i, 'Calendar'],
  [/lenovocompanion/i, 'Lenovo'],
  [/^dev\.lyra\.companion$/i, 'Lyra'],
  [/^claude_/i, 'Claude'],
  [/yourphone|phonelink/i, 'Phone Link'],
  [/whatsapp/i, 'WhatsApp']
]

/** "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App" → "WhatsAppDesktop"; "com.squirrel.slack.slack" → "slack" */
function appName(primaryId) {
  let id = String(primaryId || '').trim()
  if (!id) return 'Windows'
  for (const [re, name] of KNOWN) if (re.test(id)) return name
  if (/^[a-z]:\\/i.test(id) || id.includes('\\')) id = path.win32.basename(id).replace(/\.exe$/i, '')
  const web = /!https?:\/\/(?:www\.)?([^/]+)/i.exec(id)
  if (web) return web[1]
  id = id.split('!')[0].replace(/_[a-z0-9]{13}$/i, '')
  const parts = id.split(/[.\s]+/).filter((p) => p && !GENERIC.test(p) && !/^[0-9A-F]{8}$/i.test(p))
  const name = (parts[parts.length - 1] || id).replace(/([a-z])([A-Z])/g, '$1 $2')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

const fromFiletime = (ticks100ns) => Math.round(Number(ticks100ns) / 10000) - FILETIME_EPOCH_MS

// ------------------------------------------------------------ runtime
function start({ emit, selfIds = [] }) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch {
    return () => {}
  }
  const dir = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications')
  const files = ['wpndatabase.db', 'wpndatabase.db-wal', 'wpndatabase.db-shm']
  const selfList = selfIds.map((s) => s.toLowerCase())
  const self = new Set(selfList)
  let lastId = null
  let lastSig = ''
  let busy = false

  const sig = () => {
    try {
      return files.map((f) => {
        const s = fs.statSync(path.join(dir, f), { throwIfNoEntry: false })
        return s ? `${s.size}:${s.mtimeMs}` : '-'
      }).join('|')
    } catch {
      return ''
    }
  }

  function poll() {
    if (busy) return
    const s = sig()
    if (!s || s === lastSig) return
    busy = true
    let tmp = ''
    let db = null
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spidey-wpn-'))
      for (const f of files) {
        try {
          fs.copyFileSync(path.join(dir, f), path.join(tmp, f))
        } catch {
          /* -shm / -wal may not exist */
        }
      }
      db = new DatabaseSync(path.join(tmp, 'wpndatabase.db'))
      const base =
        'SELECT n.Id AS id, CAST(n.ArrivalTime / 10000 AS INTEGER) AS ms, h.PrimaryId AS app, n.Payload AS payload ' +
        "FROM Notification n JOIN NotificationHandler h ON n.HandlerId = h.RecordId WHERE n.Type = 'toast'" +
        (selfList.length ? ` AND lower(h.PrimaryId) NOT IN (${selfList.map(() => '?').join(',')})` : '')
      let rows
      if (lastId === null) {
        const cutoff = (Date.now() - BACKFILL_MS + FILETIME_EPOCH_MS) * 10000
        rows = db.prepare(`${base} AND n.ArrivalTime > ? ORDER BY n.Id DESC LIMIT ${BACKFILL_MAX}`).all(...selfList, cutoff).reverse()
        const max = db.prepare('SELECT MAX(Id) AS m FROM Notification').get()
        lastId = Number(max?.m) || 0
      } else {
        rows = db.prepare(`${base} AND n.Id > ? ORDER BY n.Id`).all(...selfList, lastId)
      }
      const out = []
      for (const r of rows) {
        lastId = Math.max(lastId, Number(r.id))
        if (self.has(String(r.app).toLowerCase())) continue
        const t = parseToast(r.payload)
        if (!t) continue
        out.push({ id: Number(r.id), app: appName(r.app), appId: String(r.app).slice(0, 120), title: t.title, body: t.body, at: r.ms - FILETIME_EPOCH_MS })
      }
      if (out.length) emit(out)
      lastSig = s
    } catch {
      /* locked or schema changed: try again next tick */
    } finally {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
      busy = false
    }
  }

  const timer = setInterval(poll, POLL_MS)
  setTimeout(poll, 2500)
  return () => clearInterval(timer)
}

module.exports = { start, parseToast, appName, decodeXml, fromFiletime }
