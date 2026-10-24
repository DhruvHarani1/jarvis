'use strict'
// Unit tests for router/retry.js, router/ledger.js, router/health.js.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const retry = require('../router/retry')
const ledger = require('../router/ledger')
const health = require('../router/health')

const hdr = (v) => ({ get: (n) => (n.toLowerCase() === 'retry-after' ? v : null) })

// ---- retry-after: every place a provider might say it
assert.equal(retry.retryAfterMs({ headers: hdr('30') }), 30_000)
assert.equal(retry.retryAfterMs({ headers: hdr('1.5') }), 1500)
assert.equal(retry.retryAfterMs({ headers: hdr('Wed, 21 Oct 2026 07:28:30 GMT'), now: Date.parse('Wed, 21 Oct 2026 07:28:00 GMT') }), 30_000, 'HTTP date')
assert.equal(retry.retryAfterMs({ headers: hdr('Wed, 21 Oct 2026 07:28:30 GMT'), now: Date.parse('Wed, 21 Oct 2026 09:00:00 GMT') }), 0, 'a date in the past is zero, not negative')
assert.equal(retry.retryAfterMs({ headers: hdr('99999999999') }), retry.MAX_MS, 'a hostile value is capped at a day')
assert.equal(retry.retryAfterMs({ headers: hdr('soon') }), undefined)
assert.equal(retry.retryAfterMs({ body: JSON.stringify({ error: { details: [{ retryDelay: '17s' }] } }) }), 17_000, 'Google style, nested')
assert.equal(retry.retryAfterMs({ body: JSON.stringify({ error: { retry_after: 3 } }) }), 3000)
assert.equal(retry.retryAfterMs({ body: JSON.stringify({ retry_after_ms: 2500 }) }), 2500)
assert.equal(retry.retryAfterMs({ body: JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 1m26.4s.' } }) }), 86_400, 'Groq prose inside JSON')
assert.equal(retry.retryAfterMs({ body: 'Rate limit hit, retry after 2 minutes' }), 120_000)
assert.equal(retry.retryAfterMs({ body: 'try again in 6m0.512s' }), 360_512)
assert.equal(retry.retryAfterMs({ body: 'try again in 500ms' }), 500)
assert.equal(retry.retryAfterMs({ body: 'You exceeded your quota of 100 requests' }), undefined, 'an unrelated number is not a delay')
assert.equal(retry.retryAfterMs({ headers: hdr('5'), body: 'try again in 90s' }), 5000, 'the header wins')
assert.equal(retry.retryAfterMs({}), undefined)
assert.equal(retry.parseDuration('3 weeks'), undefined)
assert.equal(retry.isDailyLimit('Rate limit reached for model in organization on tokens per day (TPD)'), true)
assert.equal(retry.isDailyLimit('You exceeded your current quota, requests per day limit: 20'), true)
assert.equal(retry.isDailyLimit('Rate limit reached: 30 requests per minute'), false)

// ---- ledger: minute windows
let t = Date.UTC(2026, 9, 24, 10, 0, 0)
const now = () => t
const L = ledger.create({ now })
const lim = { rpm: 3, rpd: 5, tpm: 1000, tpd: 3000 }
for (let i = 0; i < 3; i++) {
  assert.deepEqual(L.check('k', lim, 100), { ok: true })
  L.record('k', 100)
  t += 1000
}
let c = L.check('k', lim, 100)
assert.deepEqual([c.ok, c.reason], [false, 'minute'])
assert.ok(c.waitMs > 50_000 && c.waitMs <= 57_000, 'wait until the oldest request leaves the window: ' + c.waitMs)
t += 58_000
assert.equal(L.check('k', lim, 100).ok, true, 'the window slid')
// tokens per minute
const L2 = ledger.create({ now })
L2.record('a', 900)
assert.equal(L2.check('a', { tpm: 1000 }, 200).reason, 'minute')
assert.equal(L2.check('a', { tpm: 1000 }, 50).ok, true)
assert.equal(L2.check('a', {}, 1e9).ok, true, 'no limits known: never blocked by the ledger')

// ---- ledger: daily counters reset at UTC midnight
const L3 = ledger.create({ now })
const dl = { rpd: 4 }
for (let i = 0; i < 4; i++) {
  assert.equal(L3.check('d', dl).ok, true)
  L3.record('d')
  t += 61_000 // spread over minutes so no minute limit is involved
}
c = L3.check('d', dl)
assert.deepEqual([c.ok, c.reason], [false, 'day'])
const midnight = ledger.nextUtcMidnight(t)
assert.equal(c.waitMs, midnight - t)
t = midnight + 1000
assert.equal(L3.check('d', dl).ok, true, 'a new UTC day starts fresh')
assert.equal(L3.usage('d', dl).rpdUsed, 0)

// provider says the day is over: blocked until midnight regardless of the catalog
const L4 = ledger.create({ now })
L4.blockUntilMidnight('x')
assert.equal(L4.check('x', {}).reason, 'blocked')
assert.ok(L4.usage('x').blockedUntil > t)
t = ledger.nextUtcMidnight(t) + 5
assert.equal(L4.check('x', {}).ok, true)

// ---- ledger: persistence (same day only)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ledger-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
const f = path.join(dir, 'quota.json')
const P1 = ledger.create({ file: f, now })
P1.record('p', 500)
P1.record('p', 500)
P1.blockUntilMidnight('blocked')
await_save()
function await_save() {
  // the save is debounced; force the same effect the timer would have
  const wait = Date.now() + 2500
  while (Date.now() < wait) { /* spin briefly: the test is about the file, not the timer */ }
}
setTimeout(() => {
  const P2 = ledger.create({ file: f, now })
  assert.deepEqual([P2.usage('p').rpdUsed, P2.usage('p').tpdUsed], [2, 1000], 'today\'s counts survive a restart')
  assert.equal(P2.check('blocked', {}).reason, 'blocked')
  t += 86_400_000
  const P3 = ledger.create({ file: f, now })
  assert.equal(P3.usage('p').rpdUsed, 0, 'yesterday\'s counts are not loaded')
  assert.deepEqual(ledger.create({ file: path.join(dir, 'missing.json'), now }).usage('q'), { rpmUsed: 0, rpmLimit: null, rpdUsed: 0, rpdLimit: null, tpdUsed: 0, tpdLimit: null, blockedUntil: 0 })

  // ---- health
  let ht = 1_000_000
  const H = health.create({ now: () => ht })
  assert.equal(H.reliability('new'), 0.5)
  assert.ok(Math.abs(H.score('new') - (0.65 * 0.5 + 0.35 * 0.6)) < 1e-9, 'unknown keys rank in the middle')
  for (let i = 0; i < 10; i++) H.success('fast', 400)
  for (let i = 0; i < 10; i++) H.success('slow', 4000)
  for (let i = 0; i < 10; i++) H.failure('flaky')
  assert.ok(H.score('fast') > H.score('slow'), 'faster first word ranks higher')
  assert.ok(H.score('slow') > H.score('flaky'), 'reliable but slow beats failing')
  assert.ok(H.score('flaky') < H.score('new'))
  assert.equal(H.avgTtfb('fast'), 400)
  // old failures fade
  const H2 = health.create({ now: () => ht })
  for (let i = 0; i < 10; i++) H2.failure('k')
  const bad = H2.reliability('k')
  ht += 8 * 86_400_000
  H2.success('k', 500)
  assert.ok(H2.reliability('k') > bad + 0.2, 'a week later the old failures barely count')
  // first-word patience
  assert.equal(H.ttfbBudget('new'), health.DEFAULT_BUDGET_MS)
  assert.equal(H.ttfbBudget('fast'), health.MIN_BUDGET_MS, 'a fast key is not given long to answer')
  assert.equal(H.ttfbBudget('slow'), 8000, 'a slow key gets its own p95 plus margin (4000*1.5+2000)')
  const H3 = health.create({ now: () => ht })
  for (let i = 0; i < 6; i++) H3.success('huge', 60_000)
  assert.equal(H3.ttfbBudget('huge'), health.MAX_BUDGET_MS, 'but never more than the cap')

  console.log('router: ALL PASS')
}, 100)
