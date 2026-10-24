'use strict'
/**
 * How long a provider says to wait after "429 too many requests". Providers say it in different places and formats:
 * the Retry-After header (seconds or an HTTP date), a field in the JSON error body ("retryDelay": "17s", "retry_after": 3),
 * or plain prose ("Please try again in 1m26s"). The idea of reading all of them comes from FreeLLMAPI (MIT, tashfeenahmed/freellmapi,
 * server/src/providers/base.ts); this is a fresh implementation. A hostile value can never bench a key for more than a day.
 */
const MAX_MS = 24 * 3600 * 1000
const UNIT_MS = { ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000 }

const clamp = (ms) => (Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_MS) : undefined)

/** "1m26s", "6m0.512s", "17s", "2 minutes", "500ms" -> ms */
function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase()
  if (!t) return undefined
  let total = 0
  let any = false
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    const u = UNIT_MS[m[2]]
    if (!u) return undefined
    total += Number(m[1]) * u
    any = true
  }
  return any ? clamp(total) : undefined
}

function fromHeader(value, now) {
  if (!value) return undefined
  const v = String(value).trim()
  if (/^\d+(\.\d+)?$/.test(v)) return clamp(Number(v) * 1000)
  const when = Date.parse(v)
  return Number.isNaN(when) ? undefined : clamp(Math.max(0, when - now))
}

/** depth-limited search of a JSON error body for retryDelay / retry_after style fields */
function fromJson(node, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return undefined
  for (const [k, v] of Object.entries(node)) {
    if (/^(retry[_-]?after(_ms|_seconds)?|retry[_-]?delay)$/i.test(k)) {
      if (typeof v === 'number') return clamp(/_ms$/i.test(k) ? v : v * 1000)
      if (typeof v === 'string') {
        const d = /^\d+(\.\d+)?$/.test(v) ? clamp(Number(v) * 1000) : parseDuration(v)
        if (d !== undefined) return d
      }
    }
  }
  for (const v of Object.values(node)) {
    const r = Array.isArray(v) ? v.map((x) => fromJson(x, depth + 1)).find((x) => x !== undefined) : fromJson(v, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

const PROSE = /(?:try again|retry)\s+(?:in|after)\s+(\d+(?:\.\d+)?\s*[a-z]+(?:\s*\d+(?:\.\d+)?\s*[a-z]+)*)/i

/**
 * @param {{headers?:{get:(n:string)=>string|null}|null, body?:string, now?:number}} o
 * @returns {number|undefined} milliseconds to wait
 */
function retryAfterMs({ headers, body, now = Date.now() }) {
  const h = headers && typeof headers.get === 'function' ? fromHeader(headers.get('retry-after'), now) : undefined
  if (h !== undefined) return h
  const text = String(body || '')
  try {
    const j = fromJson(JSON.parse(text))
    if (j !== undefined) return j
  } catch {
    /* not JSON */
  }
  const p = PROSE.exec(text)
  return p ? parseDuration(p[1]) : undefined
}

/** does the 429 say the DAILY allowance is gone (so waiting a minute is pointless)? */
function isDailyLimit(body) {
  return /per[ -]day|daily|requests? per day|\brpd\b|\btpd\b|tokens? per day|quota.*(exceeded|exhausted).*day/i.test(String(body || ''))
}

module.exports = { retryAfterMs, parseDuration, isDailyLimit, MAX_MS }
