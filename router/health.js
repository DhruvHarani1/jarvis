'use strict'
/**
 * How well each key has been doing lately: a success rate where old results count less (half-life two days, like FreeLLMAPI's
 * reliability score but without the bandit: with a handful of keys a plain, explainable score is enough) and the time to the
 * first word. A voice assistant cares about the first word, so that also sets how long to wait before trying the next key.
 */
const HALF_LIFE_MS = 2 * 24 * 3600 * 1000
const MIN_BUDGET_MS = 6_000
const MAX_BUDGET_MS = 20_000
const DEFAULT_BUDGET_MS = 12_000
const KEEP = 40

/** @param {{now?:()=>number}} o */
function create({ now = Date.now } = {}) {
  /** @type {Map<string, {results:{t:number, ok:boolean}[], ttfb:number[]}>} */
  const m = new Map()
  const slot = (id) => {
    if (!m.has(id)) m.set(id, { results: [], ttfb: [] })
    return m.get(id)
  }
  const weight = (t) => Math.pow(0.5, (now() - t) / HALF_LIFE_MS)

  function success(id, ttfbMs) {
    const s = slot(id)
    s.results.push({ t: now(), ok: true })
    if (Number.isFinite(ttfbMs) && ttfbMs > 0) s.ttfb.push(ttfbMs)
    if (s.results.length > KEEP) s.results.shift()
    if (s.ttfb.length > KEEP) s.ttfb.shift()
  }
  function failure(id) {
    const s = slot(id)
    s.results.push({ t: now(), ok: false })
    if (s.results.length > KEEP) s.results.shift()
  }

  /** 0..1, 0.5 when nothing is known; more samples move it away from 0.5 (Laplace smoothing) */
  function reliability(id) {
    const s = slot(id)
    let ok = 0
    let bad = 0
    for (const r of s.results) r.ok ? (ok += weight(r.t)) : (bad += weight(r.t))
    return (ok + 1) / (ok + bad + 2)
  }
  const percentile = (arr, p) => {
    if (!arr.length) return null
    const a = [...arr].sort((x, y) => x - y)
    return a[Math.min(a.length - 1, Math.floor(p * a.length))]
  }
  const avgTtfb = (id) => {
    const t = slot(id).ttfb
    return t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null
  }
  /** a key with no history ranks in the middle; faster and more reliable ranks higher */
  function score(id) {
    const a = avgTtfb(id)
    const speed = a === null ? 0.6 : Math.max(0, Math.min(1, 1 - (a - 300) / 4700)) // 300 ms -> 1.0, 5 s -> 0
    return 0.65 * reliability(id) + 0.35 * speed
  }
  /** how long to wait for the first word before giving up on this key: its own slow end plus a margin, within sane limits */
  function ttfbBudget(id) {
    const t = slot(id).ttfb
    if (t.length < 5) return DEFAULT_BUDGET_MS
    return Math.max(MIN_BUDGET_MS, Math.min(MAX_BUDGET_MS, Math.round(percentile(t, 0.95) * 1.5 + 2000)))
  }
  const samples = (id) => slot(id).results.length
  const forget = (id) => m.delete(id)

  return { success, failure, reliability, score, avgTtfb, ttfbBudget, samples, forget, DEFAULT_BUDGET_MS }
}

module.exports = { create, MIN_BUDGET_MS, MAX_BUDGET_MS, DEFAULT_BUDGET_MS }
