'use strict'
/**
 * Timers and reminders. Persisted to a JSON file so they survive a restart; a reminder that came due while Jarvis was
 * closed is announced as "missed" on the next start (if it is less than a day old).
 */
const fs = require('node:fs')
const path = require('node:path')

const MAX_REMINDERS = 100
const MAX_DELAY_MS = 366 * 24 * 3600 * 1000
const LATE_LIMIT_MS = 24 * 3600 * 1000
const CHUNK_MS = 2 ** 30 // setTimeout cannot take more than ~24 days

/**
 * @param {{file:string, onFire:(r:{id:number,text:string,at:number,late:boolean})=>void, now?:()=>number, setTimer?:Function, clearTimer?:Function}} o
 */
function create({ file, onFire, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @type {{id:number,at:number,text:string}[]} */
  let items = []
  let nextId = 1
  const timers = new Map()

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ nextId, items }))
    } catch {
      /* a full disk must not crash the app; reminders then live in memory only */
    }
  }

  function arm(r) {
    clearTimer(timers.get(r.id))
    const wait = Math.max(0, r.at - now())
    const t = setTimer(() => {
      if (r.at - now() > 1000) return arm(r) // a long wait is armed in chunks
      fire(r, false)
    }, Math.min(wait, CHUNK_MS))
    if (t && t.unref) t.unref()
    timers.set(r.id, t)
  }

  function fire(r, late) {
    items = items.filter((x) => x.id !== r.id)
    timers.delete(r.id)
    save()
    try {
      onFire({ id: r.id, text: r.text, at: r.at, late })
    } catch {
      /* a listener bug must not stop other reminders */
    }
  }

  function start() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      items = Array.isArray(j.items) ? j.items.filter((r) => r && Number.isFinite(r.at) && typeof r.text === 'string') : []
      nextId = Number.isInteger(j.nextId) ? j.nextId : items.reduce((m, r) => Math.max(m, r.id), 0) + 1
    } catch {
      items = []
    }
    for (const r of [...items]) {
      if (r.at <= now()) {
        if (now() - r.at < LATE_LIMIT_MS) fire(r, true)
        else items = items.filter((x) => x.id !== r.id)
      } else arm(r)
    }
    save()
  }

  /** @returns {{ok:true, id:number, at:number}|{ok:false, error:string}} */
  function add({ at, text }) {
    if (!Number.isFinite(at) || at < now() - 1000) return { ok: false, error: 'that time has already passed' }
    if (at - now() > MAX_DELAY_MS) return { ok: false, error: 'that is more than a year away' }
    if (items.length >= MAX_REMINDERS) return { ok: false, error: 'too many reminders; cancel some first' }
    const r = { id: nextId++, at, text: String(text || '').slice(0, 200) }
    items.push(r)
    save()
    arm(r)
    return { ok: true, id: r.id, at: r.at }
  }

  function cancel(id) {
    const had = items.some((r) => r.id === id)
    items = items.filter((r) => r.id !== id)
    clearTimer(timers.get(id))
    timers.delete(id)
    if (had) save()
    return had
  }

  const list = () => [...items].sort((a, b) => a.at - b.at)
  function stop() {
    for (const t of timers.values()) clearTimer(t)
    timers.clear()
  }

  return { start, add, cancel, list, stop }
}

module.exports = { create, MAX_REMINDERS }
