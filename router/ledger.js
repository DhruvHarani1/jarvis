'use strict'
/**
 * Quota ledger: how much of each key's free allowance is used. Sliding one-minute windows for requests and tokens
 * (RPM, TPM) and UTC-day counters (RPD, TPD), because providers reset at UTC midnight. Limits come from the catalog; a
 * provider that tells us it is out for the day is believed over the catalog. Day counters are saved so a restart does not
 * make Jarvis think a key is fresh. (The windows and the UTC-day rule follow FreeLLMAPI's quota engine, MIT; code is new.)
 */
const fs = require('node:fs')
const path = require('node:path')

const DAY_MS = 86_400_000
const utcDay = (t) => Math.floor(t / DAY_MS)
const nextUtcMidnight = (t) => (utcDay(t) + 1) * DAY_MS

/** @param {{file?:string, now?:()=>number}} o */
function create({ file, now = Date.now } = {}) {
  /** @type {Map<string, {reqs:number[], toks:{t:number,n:number}[], day:number, dayReqs:number, dayToks:number, blockedUntil:number}>} */
  const keys = new Map()
  let saveTimer = null

  try {
    if (file) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const [id, v] of Object.entries(j.keys || {})) {
        if (v && v.day === utcDay(now())) keys.set(id, { reqs: [], toks: [], day: v.day, dayReqs: v.dayReqs | 0, dayToks: v.dayToks | 0, blockedUntil: Number(v.blockedUntil) || 0 })
      }
    }
  } catch {
    /* first run */
  }

  function save() {
    if (!file) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const out = {}
        for (const [id, s] of keys) out[id] = { day: s.day, dayReqs: s.dayReqs, dayToks: s.dayToks, blockedUntil: s.blockedUntil }
        fs.writeFileSync(file, JSON.stringify({ keys: out }))
      } catch {
        /* usage numbers are a convenience; never break a request over them */
      }
    }, 2000)
    if (saveTimer.unref) saveTimer.unref()
  }

  function slot(id) {
    let s = keys.get(id)
    const t = now()
    if (!s) keys.set(id, (s = { reqs: [], toks: [], day: utcDay(t), dayReqs: 0, dayToks: 0, blockedUntil: 0 }))
    if (s.day !== utcDay(t)) Object.assign(s, { day: utcDay(t), dayReqs: 0, dayToks: 0, blockedUntil: 0 }) // new UTC day: everything is fresh
    const cut = t - 60_000
    while (s.reqs.length && s.reqs[0] <= cut) s.reqs.shift()
    while (s.toks.length && s.toks[0].t <= cut) s.toks.shift()
    return s
  }

  /**
   * Can this key take a request of about `tokens` tokens right now?
   * @param {{rpm?:number|null, rpd?:number|null, tpm?:number|null, tpd?:number|null}} limits
   * @returns {{ok:true}|{ok:false, waitMs:number, reason:'minute'|'day'|'blocked'}}
   */
  function check(id, limits = {}, tokens = 0) {
    const s = slot(id)
    const t = now()
    if (s.blockedUntil > t) return { ok: false, waitMs: s.blockedUntil - t, reason: 'blocked' }
    if (limits.rpd && s.dayReqs + 1 > limits.rpd) return { ok: false, waitMs: nextUtcMidnight(t) - t, reason: 'day' }
    if (limits.tpd && s.dayToks + tokens > limits.tpd) return { ok: false, waitMs: nextUtcMidnight(t) - t, reason: 'day' }
    if (limits.rpm && s.reqs.length + 1 > limits.rpm) return { ok: false, waitMs: Math.max(1000, s.reqs[0] + 60_000 - t), reason: 'minute' }
    if (limits.tpm && tokens && s.toks.reduce((a, x) => a + x.n, 0) + tokens > limits.tpm) return { ok: false, waitMs: Math.max(1000, (s.toks[0] ? s.toks[0].t : t) + 60_000 - t), reason: 'minute' }
    return { ok: true }
  }

  function record(id, tokens = 0) {
    const s = slot(id)
    const t = now()
    s.reqs.push(t)
    if (tokens > 0) {
      s.toks.push({ t, n: tokens })
      s.dayToks += tokens
    }
    s.dayReqs++
    save()
  }

  /** the provider said the daily allowance is gone: no use trying until UTC midnight */
  function blockUntilMidnight(id) {
    slot(id).blockedUntil = nextUtcMidnight(now())
    save()
  }

  function usage(id, limits = {}) {
    const s = slot(id)
    return { rpmUsed: s.reqs.length, rpmLimit: limits.rpm || null, rpdUsed: s.dayReqs, rpdLimit: limits.rpd || null, tpdUsed: s.dayToks, tpdLimit: limits.tpd || null, blockedUntil: s.blockedUntil > now() ? s.blockedUntil : 0 }
  }
  const forget = (id) => (keys.delete(id), save())

  return { check, record, blockUntilMidnight, usage, forget, nextUtcMidnight }
}

module.exports = { create, utcDay, nextUtcMidnight, DAY_MS }
