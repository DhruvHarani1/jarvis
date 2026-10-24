'use strict'
// The free-AI router inside brain.js: quota ledger, daily limits, smart ordering, retry hints, new providers, usage listing.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const B = require('../brain')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-router-test-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
const crypt = { available: () => true, enc: (s) => Buffer.from(s).toString('base64'), dec: (s) => Buffer.from(s, 'base64').toString() }
const msgs = [{ role: 'user', content: 'hi' }]
const day = 86_400_000
let clock = Date.UTC(2026, 9, 24, 10, 0, 0)
const now = () => clock

/** fake provider network: handler(key, url) -> {status, body, headers}; counts calls per key */
function net(handler) {
  const hits = {}
  const fn = async (url, init = {}) => {
    const key = (init.headers?.Authorization || '').replace('Bearer ', '')
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm-instruct' }] }), { status: 200 })
    hits[key] = (hits[key] || 0) + 1
    const r = await handler(key, url, hits[key])
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers || {} })
  }
  fn.hits = hits
  return fn
}
const ok = (t) => ({ body: { choices: [{ message: { content: t } }] } })
const mk = (name, f, extra = {}) => B.createBrain({ file: path.join(tmp, name + '.json'), fetch: f, now, crypt, ...extra })

;(async () => {
  // ---- new providers exist, FreeLLMAPI keeps an editable local URL
  assert.ok(B.PRESETS.cerebras && B.PRESETS.mistral && B.PRESETS.freellmapi)
  assert.equal(B.PRESETS.freellmapi.baseUrl, 'http://127.0.0.1:3001/v1')
  for (const [id, p] of Object.entries(B.PRESETS)) assert.ok(p.hint !== undefined && p.name, id)
  {
    const b = mk('freellm', net(() => ok('x')))
    b.add({ provider: 'freellmapi', key: 'freellmapi-abcdef123456', label: 'my FreeLLMAPI' })
    assert.equal(b.list()[0].baseUrl, 'http://127.0.0.1:3001/v1', 'defaults to the usual local address')
    b.update(b.list()[0].id, { baseUrl: 'http://localhost:31415/v1' })
    assert.equal(b.list()[0].baseUrl, 'http://localhost:31415/v1')
    assert.throws(() => b.update(b.list()[0].id, { baseUrl: 'http://evil.example.com/v1' }), /https/)
    const fixed = mk('x2', net(() => ok('x')))
    fixed.add({ provider: 'groq', key: 'abcdefgh1234', baseUrl: 'http://anything.example' })
    assert.equal(fixed.list()[0].baseUrl, B.PRESETS.groq.baseUrl, 'a preset with a fixed URL ignores a typed one')
  }

  // ---- a request-per-minute limit is respected BEFORE asking the provider
  {
    const f = net((key) => ok('from ' + key.slice(0, 6)))
    const b = mk('rpm', f)
    b.add({ provider: 'mistral', key: 'MISTRAL_aaaaaaaa', label: 'mistral' }) // 2 requests per minute in the catalog
    b.add({ provider: 'groq', key: 'GROQKEY_bbbbbbbb', label: 'groq' })
    b.setSmartOrder(false)
    const r1 = await b.chat(msgs)
    const r2 = await b.chat(msgs)
    assert.deepEqual([r1.text, r2.text], ['from MISTRA', 'from MISTRA'])
    const r3 = await b.chat(msgs)
    assert.equal(r3.text, 'from GROQKE', 'the third request in a minute goes straight to the next key')
    assert.match(r3.chain[0], /^mistral: used up for now \(back in about 1 min\)$/)
    assert.equal(f.hits['MISTRAL_aaaaaaaa'], 2, 'the provider was never asked a third time')
    clock += 61_000
    assert.equal((await b.chat(msgs)).text, 'from MISTRA', 'a minute later it is used again')
    const u = b.list()[0].usage
    assert.deepEqual([u.rpmUsed, u.rpmLimit], [1, 2])
  }

  // ---- "out for the day" (daily limit in the 429 text) benches the key until UTC midnight
  {
    const f = net((key) => (key.startsWith('DAILY') ? { status: 429, body: { error: { message: 'Rate limit reached for model on tokens per day (TPD): Limit 100000. Please try again in 5h3m.' } } } : ok('from other')))
    const b = mk('daily', f)
    b.add({ provider: 'groq', key: 'DAILYKEY_aaaaaaaa', label: 'a' })
    b.add({ provider: 'cerebras', key: 'OTHERKEY_bbbbbbbb', label: 'b' })
    b.setSmartOrder(false)
    const r = await b.chat(msgs)
    assert.equal(r.text, 'from other')
    const l = b.list()[0]
    assert.equal(l.status, 'cooling')
    const toMidnight = Math.ceil((Math.floor(clock / day) * day + day - clock) / 1000)
    assert.equal(l.cooldownS, toMidnight, 'benched until UTC midnight, not for the 5 hours the text mentions')
    assert.ok(l.usage.blockedUntil > clock)
    clock += day
    const r2 = await b.chat(msgs)
    assert.equal(r2.chain[0].startsWith('a:'), true, 'the next day the key is tried again')
  }

  // ---- the wait the provider names in plain prose is honoured
  {
    const f = net((key) => (key.startsWith('PROSE') ? { status: 429, body: 'Rate limit reached. Please try again in 1m26s.' } : ok('fine')))
    const b = mk('prose', f)
    b.add({ provider: 'groq', key: 'PROSEKEY_aaaaaaaa', label: 'a' })
    b.add({ provider: 'cerebras', key: 'OTHERKEY_bbbbbbbb', label: 'b' })
    b.setSmartOrder(false)
    await b.chat(msgs)
    assert.equal(b.list()[0].cooldownS, 86)
  }

  // ---- smart order: a key that has been fast and reliable is tried first, whatever the saved order
  {
    const f = net(async (key) => {
      if (key.startsWith('FLAKY')) return { status: 500, body: 'boom' }
      return ok('from ' + key.slice(0, 5))
    })
    const b = mk('smart', f)
    b.add({ provider: 'cerebras', key: 'FLAKYKEY_aaaaaaaa', label: 'flaky' })
    b.add({ provider: 'groq', key: 'GOODKEY_bbbbbbbb', label: 'good' })
    for (let i = 0; i < 3; i++) {
      clock += 5 * 60_000
      await b.chat(msgs)
    }
    clock += 60 * 60_000
    const before = f.hits['FLAKYKEY_aaaaaaaa']
    const r = await b.chat(msgs)
    assert.equal(r.text, 'from GOODK')
    assert.deepEqual(r.chain, ['good: ok'], 'the failing key was not even tried first')
    assert.equal(f.hits['FLAKYKEY_aaaaaaaa'], before)
    // with smart order off the saved order wins again
    b.setSmartOrder(false)
    clock += 10 * 60_000
    const r2 = await b.chat(msgs)
    assert.match(r2.chain[0], /^flaky:/)
    assert.equal(b.getSettings().smartOrder, false)
    // and the choice is remembered across a restart
    const b2 = B.createBrain({ file: path.join(tmp, 'smart.json'), fetch: f, now, crypt })
    assert.equal(b2.getSettings().smartOrder, false)
  }

  // ---- listing: usage, privacy note, first-word time
  {
    const b = mk('list', net(() => ok('hello')))
    b.add({ provider: 'gemini', key: 'GEMINIKEY_aaaaaaaa', label: 'g' })
    await b.chat(msgs)
    const l = b.list()[0]
    assert.deepEqual([l.usage.rpdUsed, l.usage.rpdLimit, l.usage.rpmLimit], [1, 250, 10])
    assert.equal(l.privacy.level, 'trains', 'the Gemini free tier is labelled as one that may train on your data')
    assert.ok(l.avgFirstWordMs === null || l.avgFirstWordMs >= 0)
    assert.ok(!JSON.stringify(l).includes('GEMINIKEY'), 'the key is never listed')
  }

  console.log('brain-router: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
