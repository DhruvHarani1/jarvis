'use strict'
// Unit tests for the failover brain (fake network, fake clock, fake encryption).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const B = require('../brain')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'))
const mk = (name) => path.join(tmp, name + '.json')
// reversible "encryption" that is obviously not the plaintext
const crypt = { available: () => true, enc: (s) => Buffer.from([...s].reverse().join('') + '#enc').toString('base64'), dec: (s) => [...Buffer.from(s, 'base64').toString().replace(/#enc$/, '')].reverse().join('') }

/** a scripted fake provider network: handler(url, key, body) -> {status, body, headers} or throws */
function fakeNet(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    const key = (init.headers?.Authorization || '').replace('Bearer ', '')
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, key, body, method: init.method })
    const r = await handler(url, key, body, init)
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers || {} })
  }
  fn.calls = calls
  return fn
}
const answer = (text) => ({ status: 200, body: { choices: [{ message: { content: text } }] } })
const models = (...ids) => ({ status: 200, body: { data: ids.map((id) => ({ id })) } })

const msgs = [{ role: 'user', content: 'hi' }]
let clock = 1_000_000
const now = () => clock

;(async () => {
  // ---------- keys are encrypted at rest and never listed
  {
    const net = fakeNet(() => answer('x'))
    const b = B.createBrain({ file: mk('enc'), fetch: net, now, crypt })
    const id = b.add({ provider: 'groq', key: 'gsk_SECRETKEY123456', label: 'my groq' })
    const raw = fs.readFileSync(mk('enc'), 'utf8')
    assert.ok(!raw.includes('SECRETKEY'), 'plaintext key must not be on disk')
    assert.ok(!JSON.stringify(b.list()).includes('SECRETKEY'), 'public list never contains the key')
    assert.equal(b.list()[0].keyHint, '…3456')
    // survives a restart
    const b2 = B.createBrain({ file: mk('enc'), fetch: net, now, crypt })
    assert.equal(b2.list().length, 1)
    assert.equal(b2.list()[0].id, id)
    // no encryption available => refuse to store
    const noCrypt = B.createBrain({ file: mk('nocrypt'), fetch: net, now, crypt: { ...crypt, available: () => false } })
    assert.throws(() => noCrypt.add({ provider: 'groq', key: 'gsk_abcdefgh1234' }), /encryption/i)
    assert.ok(!fs.existsSync(mk('nocrypt')), 'nothing was written')
  }

  // ---------- validation
  {
    const b = B.createBrain({ file: mk('val'), fetch: fakeNet(() => answer('x')), now, crypt })
    assert.throws(() => b.add({ provider: 'nope', key: 'abcdefgh1234' }), /unknown provider/)
    assert.throws(() => b.add({ provider: 'groq', key: 'short' }), /API key/)
    assert.throws(() => b.add({ provider: 'groq', key: 'has space in it 12345' }), /API key/)
    assert.throws(() => b.add({ provider: 'custom', key: 'abcdefgh1234', baseUrl: 'http://evil.example.com/v1' }), /https/)
    assert.throws(() => b.add({ provider: 'custom', key: 'abcdefgh1234', baseUrl: 'https://user:pw@x.com/v1' }), /https/)
    assert.doesNotThrow(() => b.add({ provider: 'custom', key: 'abcdefgh1234', baseUrl: 'http://127.0.0.1:8080/v1/' }))
    assert.equal(b.list()[0].baseUrl, 'http://127.0.0.1:8080/v1', 'trailing slash removed; localhost http allowed')
    assert.equal(B.cleanBaseUrl('https://api.mistral.ai/v1'), 'https://api.mistral.ai/v1')
    assert.equal(B.cleanBaseUrl('ftp://x.com'), '')
  }

  // ---------- happy path: first key answers, model auto-detected from the key's own model list
  {
    const net = fakeNet((url, key) => (url.endsWith('/models') ? models('openai/gpt-oss-20b', 'llama-3.3-70b-versatile') : answer('{"say":"Hello!","do":""}')))
    const b = B.createBrain({ file: mk('happy'), fetch: net, now, crypt })
    b.add({ provider: 'groq', key: 'gsk_aaaaaaaa1111', label: 'groq 1' })
    const r = await b.chat(msgs)
    assert.equal(r.ok, true)
    assert.equal(r.text, '{"say":"Hello!","do":""}')
    assert.match(r.via, /groq 1 \(llama-3\.3-70b-versatile\)/, 'prefers the first preferred model the key can see')
    const post = net.calls.find((c) => c.method === 'POST')
    assert.equal(post.url, 'https://api.groq.com/openai/v1/chat/completions')
    assert.equal(post.key, 'gsk_aaaaaaaa1111')
    assert.equal(post.body.stream, false)
    assert.deepEqual(post.body.messages, msgs)
    assert.equal(b.list()[0].status, 'ok')
  }

  // ---------- failover: key 1 rate-limited -> key 2 answers; key 1 is then skipped during its cooldown, and returns afterwards
  {
    let n1 = 0
    const net = fakeNet((url, key) => {
      if (url.endsWith('/models')) return models('llama-3.3-70b-versatile', 'meta/llama-3.3-70b-instruct', 'gemini-2.5-flash')
      if (key === 'KEY1_aaaaaaaa') {
        n1++
        return { status: 429, body: { error: { message: 'rate limit' } }, headers: { 'retry-after': '30' } }
      }
      return answer('from key two')
    })
    const b = B.createBrain({ file: mk('fail1'), fetch: net, now, crypt })
    b.add({ provider: 'nvidia', key: 'KEY1_aaaaaaaa', label: 'nvidia' })
    b.add({ provider: 'groq', key: 'KEY2_bbbbbbbb', label: 'groq' })
    let r = await b.chat(msgs)
    assert.equal(r.ok, true)
    assert.equal(r.text, 'from key two')
    assert.deepEqual(r.chain, ['nvidia: rate limit reached', 'groq: ok'])
    assert.equal(b.list()[0].status, 'cooling')
    assert.equal(b.list()[0].cooldownS, 30, 'honours Retry-After')
    r = await b.chat(msgs)
    assert.equal(n1, 1, 'key 1 is not hammered while cooling')
    assert.deepEqual(r.chain, ['groq: ok'])
    clock += 31_000
    r = await b.chat(msgs)
    assert.equal(n1, 2, 'key 1 gets another chance after the cooldown')
  }

  // ---------- a rejected key is marked bad and not retried, until it is replaced
  {
    let hits = 0
    const net = fakeNet((url, key) => {
      if (url.endsWith('/models')) return models('gemini-2.5-flash')
      if (key === 'BADKEY_aaaaaaaa') { hits++; return { status: 401, body: { error: { message: 'bad key' } } } }
      return answer('fine')
    })
    const b = B.createBrain({ file: mk('bad'), fetch: net, now, crypt })
    const bad = b.add({ provider: 'gemini', key: 'BADKEY_aaaaaaaa', label: 'bad' })
    b.add({ provider: 'gemini', key: 'GOODKEY_bbbbbbbb', label: 'good' })
    await b.chat(msgs)
    await b.chat(msgs)
    assert.equal(hits, 1, 'a 401 key is never retried')
    assert.equal(b.list()[0].status, 'bad')
    assert.equal(b.list()[0].lastError, 'the key was rejected')
    clock += 3600_000
    await b.chat(msgs)
    assert.equal(hits, 1, 'still bad an hour later')
    b.update(bad, { key: 'GOODKEY_cccccccc' })
    assert.equal(b.list()[0].status, 'untested', 'replacing the key clears the bad mark')
  }

  // ---------- three tries, then local
  {
    const attempts = []
    const net = fakeNet((url, key) => {
      if (url.endsWith('/models')) return models('m')
      if (url.includes('127.0.0.1:11434')) return answer('{"say":"from the local model","do":""}')
      attempts.push(key)
      return { status: 503, body: 'down' }
    })
    const ollama = { status: async () => ({ available: true, model: 'qwen2.5:1.5b' }) }
    const b = B.createBrain({ file: mk('three'), fetch: net, now, crypt, ollama })
    for (const [i, p] of ['nvidia', 'groq', 'gemini', 'openrouter'].entries()) b.add({ provider: p, key: `KEY${i}_xxxxxxxx`, label: `k${i}` })
    const r = await b.chat(msgs)
    assert.equal(r.ok, true)
    assert.deepEqual(attempts, ['KEY0_xxxxxxxx', 'KEY1_xxxxxxxx', 'KEY2_xxxxxxxx'], 'exactly three online attempts, in order, the fourth key is not tried')
    assert.match(r.via, /local Ollama \(qwen2\.5:1\.5b\)/)
    assert.equal(r.chain.at(-1), 'local Ollama: ok')
    assert.equal(net.calls.find((c) => c.url.includes('11434')).body.model, 'qwen2.5:1.5b')
    // next question: the three failed keys are cooling, so the 4th key gets its turn
    const r2 = await b.chat(msgs)
    assert.ok(attempts.includes('KEY3_xxxxxxxx'), 'the next question reaches key 4')
  }

  // ---------- nothing works at all
  {
    const net = fakeNet(() => ({ status: 500, body: 'x' }))
    const b = B.createBrain({ file: mk('none'), fetch: net, now, crypt, ollama: { status: async () => ({ available: false, model: '' }) } })
    let r = await b.chat(msgs)
    assert.equal(r.ok, false)
    assert.match(r.error, /no AI keys/)
    b.add({ provider: 'groq', key: 'gsk_abcdefgh1234' })
    r = await b.chat(msgs)
    assert.equal(r.ok, false)
    assert.match(r.error, /every key failed/)
  }

  // ---------- network errors and timeouts count as failures, then the next key answers
  {
    let first = true
    const net = fakeNet((url, key) => {
      if (url.endsWith('/models')) return models('gemini-2.5-flash')
      if (key === 'KEY0_xxxxxxxx') throw Object.assign(new Error('fetch failed'), { name: 'TypeError' })
      if (key === 'KEY1_xxxxxxxx' && first) { first = false; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }
      return answer('third time lucky')
    })
    const b = B.createBrain({ file: mk('net'), fetch: net, now, crypt })
    for (let i = 0; i < 3; i++) b.add({ provider: 'gemini', key: `KEY${i}_xxxxxxxx`, label: `g${i}` })
    const r = await b.chat(msgs)
    assert.equal(r.text, 'third time lucky')
    assert.deepEqual(r.chain, ['g0: could not reach the server', 'g1: no answer in time', 'g2: ok'])
  }

  // ---------- exponential back-off on repeated rate limits, success resets it
  {
    const net = fakeNet((url, key) => (url.endsWith('/models') ? models('m') : { status: 429, body: 'slow down' }))
    const b = B.createBrain({ file: mk('backoff'), fetch: net, now, crypt })
    b.add({ provider: 'openrouter', key: 'KEY0_xxxxxxxx' })
    await b.chat(msgs)
    assert.equal(b.list()[0].cooldownS, 60)
    clock += 61_000
    await b.chat(msgs)
    assert.equal(b.list()[0].cooldownS, 120, 'second failure doubles the wait')
    for (let i = 0; i < 8; i++) { clock += 16 * 60_000; await b.chat(msgs) }
    assert.ok(b.list()[0].cooldownS <= 15 * 60, 'but never more than 15 minutes')
  }

  // ---------- test() button
  {
    const net = fakeNet((url, key) => (url.endsWith('/models') ? models('llama-3.3-70b-versatile') : key === 'GOOD_aaaaaaaa' ? answer('ready') : { status: 401, body: { error: { message: 'nope' } } }))
    const b = B.createBrain({ file: mk('test'), fetch: net, now, crypt })
    const g = b.add({ provider: 'groq', key: 'GOOD_aaaaaaaa' })
    const x = b.add({ provider: 'groq', key: 'BAD_aaaaaaaaa' })
    const rg = await b.test(g)
    assert.equal(rg.ok, true)
    assert.equal(rg.model, 'llama-3.3-70b-versatile')
    const rx = await b.test(x)
    assert.equal(rx.ok, false)
    assert.equal(rx.kind, 'auth')
    assert.equal(b.list()[1].status, 'bad')
    assert.equal((await b.test('nope')).ok, false)
  }

  // ---------- ordering, disabling, removing
  {
    const net = fakeNet((url, key) => (url.endsWith('/models') ? models('m') : answer(`answered by ${key}`)))
    const b = B.createBrain({ file: mk('order'), fetch: net, now, crypt })
    const a = b.add({ provider: 'groq', key: 'AAAA_aaaaaaaa', label: 'A' })
    const c = b.add({ provider: 'groq', key: 'CCCC_cccccccc', label: 'C' })
    assert.equal((await b.chat(msgs)).text, 'answered by AAAA_aaaaaaaa')
    b.move(c, -1)
    assert.deepEqual(b.list().map((e) => e.label), ['C', 'A'])
    assert.equal((await b.chat(msgs)).text, 'answered by CCCC_cccccccc')
    b.update(c, { enabled: false })
    assert.equal((await b.chat(msgs)).text, 'answered by AAAA_aaaaaaaa', 'disabled keys are skipped')
    b.remove(a)
    assert.equal(b.list().length, 1)
    assert.ok(!fs.readFileSync(mk('order'), 'utf8').includes('AAAA_aaaaaaaa'))
  }

  // ---------- ready(): natural chat needs a key or a local model, and respects the switch
  {
    const net = fakeNet(() => answer('x'))
    let local = false
    const b = B.createBrain({ file: mk('ready'), fetch: net, now, crypt, ollama: { status: async () => ({ available: local, model: 'm' }) } })
    assert.equal(await b.ready(), false)
    local = true
    assert.equal(await b.ready(), true)
    local = false
    const id = b.add({ provider: 'groq', key: 'gsk_abcdefgh1234' })
    assert.equal(await b.ready(), true)
    b.setNaturalChat(false)
    assert.equal(await b.ready(), false)
    assert.equal(b.getSettings().naturalChat, false)
  }

  // ---------- content-parts replies and classification helpers
  assert.equal(B.extractText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab')
  assert.equal(B.extractText({}), '')
  assert.equal(B.classify(429, { get: () => '5' }, '').retryAfterMs, 5000)
  assert.equal(B.classify(404, null, '{"error":{"message":"model not found"}}').kind, 'model')
  assert.equal(B.classify(400, null, 'bad model name').kind, 'model')
  assert.equal(B.classify(403, null, '').kind, 'auth')

  // ---------- the real-world NVIDIA failure: a model is LISTED but not switched on for this account (404 "Function ... Not found for account")
  {
    const tried = []
    const net = fakeNet((url, key, body) => {
      if (url.endsWith('/models')) {
        return models('meta/llama-3.3-70b-instruct', 'nvidia/nv-embedqa-e5-v5', 'nvidia/llama-3.2-nv-rerankqa-1b-v2', 'abc/some-vision-vl-model', 'meta/llama-3.1-70b-instruct', 'google/gemma-2-9b-it', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'microsoft/phi-3-mini-4k-instruct')
      }
      tried.push(body.model)
      if (body.model === 'meta/llama-3.3-70b-instruct' || body.model === 'meta/llama-3.1-70b-instruct') {
        return { status: 404, body: { status: 404, title: 'Not Found', detail: "Function '9b96341b': Not found for account 'abc'" } }
      }
      return answer('hello from ' + body.model)
    })
    const b = B.createBrain({ file: mk('nv404'), fetch: net, now, crypt })
    const id = b.add({ provider: 'nvidia', key: 'nvapi-realistic12345', label: 'nvidia' })
    const r = await b.chat(msgs)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(tried.slice(0, 2), ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-70b-instruct'], 'preferred models are tried first')
    assert.ok(!tried.some((m) => /embed|rerank|vl-model/.test(m)), 'embedding / reranker / vision models are never used for chat: ' + tried)
    assert.match(r.text, /^hello from /)
    assert.equal(b.list()[0].status, 'ok', 'a model problem is not held against the key')
    const working = tried.at(-1)
    tried.length = 0
    await b.chat(msgs)
    assert.deepEqual(tried, [working], 'the working model is remembered: no more probing')
    const t = await b.test(id)
    assert.equal(t.ok, true, 'the Test button finds a working model too')
  }
  // every candidate unavailable: a clear message and a short rest, not an endless loop
  {
    let calls = 0
    const net = fakeNet((url, key, body) => {
      if (url.endsWith('/models')) return models(...Array.from({ length: 30 }, (_, i) => 'vendor/model-' + i + '-instruct'))
      calls++
      return { status: 404, body: { detail: "Function 'x': Not found for account 'y'" } }
    })
    const b = B.createBrain({ file: mk('nv404all'), fetch: net, now, crypt })
    b.add({ provider: 'nvidia', key: 'nvapi-realistic12345' })
    const r = await b.chat(msgs)
    assert.equal(r.ok, false)
    assert.ok(calls <= 6, 'gives up after six models, got ' + calls)
    assert.match(r.chain[0], /none of the 6 models I tried are available to this key/)
    assert.equal(b.list()[0].status, 'cooling')
    assert.match(b.list()[0].lastError, /Model box/)
  }
  // an explicit model is used as typed (no probing)
  {
    const seen = []
    const net = fakeNet((url, key, body) => (url.endsWith('/models') ? models('a-instruct') : (seen.push(body.model), answer('ok'))))
    const b = B.createBrain({ file: mk('explicit'), fetch: net, now, crypt })
    b.add({ provider: 'nvidia', key: 'nvapi-realistic12345', model: 'my/own-model' })
    await b.chat(msgs)
    assert.deepEqual(seen, ['my/own-model'])
    assert.ok(!net.calls.some((c) => c.url.endsWith('/models')), 'no model listing when you chose one')
  }

  // ---------- streaming
  {
    /** a Response whose body arrives in the given raw chunks (split anywhere, even mid-line), optionally erroring or stalling at the end */
    const sse = (chunks, { error = false, stall = 0, signal = null } = {}) => {
      const enc = new TextEncoder()
      return new Response(
        new ReadableStream({
          async start(c) {
            // like a real fetch body, reading stops with an error when the request is aborted
            if (signal) signal.addEventListener('abort', () => { try { c.error(signal.reason || new Error('aborted')) } catch { /* closed */ } })
            if (stall) await new Promise((r) => setTimeout(r, stall))
            for (const ch of chunks) {
              if (signal && signal.aborted) return
              c.enqueue(enc.encode(ch))
              await new Promise((r) => setTimeout(r, 2))
            }
            if (error) c.error(new Error('connection reset'))
            else c.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    }
    const frame = (s) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: s } }] }) + '\n\n'
    const raw = frame('Hel') + frame('lo th') + frame('ere!') + 'data: [DONE]\n\n'
    // split the byte stream at awkward places
    const cuts = [raw.slice(0, 7), raw.slice(7, 31), raw.slice(31, 60), raw.slice(60)]

    const mkNet = (handler) => {
      const calls = []
      const fn = async (url, init = {}) => {
        const key = (init.headers?.Authorization || '').replace('Bearer ', '')
        const body = init.body ? JSON.parse(init.body) : null
        calls.push({ url, key, body })
        if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm-instruct' }] }), { status: 200 })
        return handler(key, body, init)
      }
      fn.calls = calls
      return fn
    }

    // pieces arrive in order and are joined into the answer; the request asked for a stream
    {
      const net = mkNet(() => sse(cuts))
      const b = B.createBrain({ file: mk('s1'), fetch: net, now, crypt })
      b.add({ provider: 'groq', key: 'gsk_streamstream1' })
      const got = []
      const r = await b.chat(msgs, (d) => got.push(d))
      assert.equal(r.ok, true)
      assert.equal(r.text, 'Hello there!')
      assert.deepEqual(got, ['Hel', 'lo th', 'ere!'])
      assert.equal(net.calls.find((c) => c.body).body.stream, true)
    }
    // failure BEFORE the first token fails over to the next key, silently (the listener never sees the bad attempt)
    {
      const net = mkNet((key) => (key === 'KEY_A_streamsss' ? new Response('{"error":{"message":"slow"}}', { status: 429, headers: { 'retry-after': '10' } }) : sse(cuts)))
      const b = B.createBrain({ file: mk('s2'), fetch: net, now, crypt })
      b.add({ provider: 'groq', key: 'KEY_A_streamsss', label: 'A' })
      b.add({ provider: 'groq', key: 'KEY_B_streamsss', label: 'B' })
      const got = []
      const r = await b.chat(msgs, (d) => got.push(d))
      assert.equal(r.ok, true)
      assert.deepEqual(r.chain, ['A: rate limit reached', 'B: ok'])
      assert.equal(got.join(''), 'Hello there!', 'no text from the failed attempt leaked into the stream')
    }
    // a connection that dies AFTER tokens started keeps what was said (no second provider repeating it)
    {
      const net = mkNet((key) => (key === 'KEY_A_streamsss' ? sse([frame('Half an ans'), frame('wer ')], { error: true }) : sse(cuts)))
      const b = B.createBrain({ file: mk('s3'), fetch: net, now, crypt })
      b.add({ provider: 'groq', key: 'KEY_A_streamsss', label: 'A' })
      b.add({ provider: 'groq', key: 'KEY_B_streamsss', label: 'B' })
      const r = await b.chat(msgs, () => {})
      assert.equal(r.ok, true)
      assert.equal(r.text, 'Half an answer')
      assert.equal(net.calls.filter((c) => c.key === 'KEY_B_streamsss' && c.body).length, 0, 'the second key was not asked to start over')
    }
    // no first token in time => treated like any other failure, next key answers
    {
      const net = mkNet((key, body, init) => (key === 'KEY_A_streamsss' ? sse(cuts, { stall: 400, signal: init.signal }) : sse(cuts)))
      const b = B.createBrain({ file: mk('s4'), fetch: net, now, crypt, firstTokenMs: 60 })
      b.add({ provider: 'groq', key: 'KEY_A_streamsss', label: 'A' })
      b.add({ provider: 'groq', key: 'KEY_B_streamsss', label: 'B' })
      const r = await b.chat(msgs, () => {})
      assert.equal(r.ok, true)
      assert.deepEqual(r.chain, ['A: no answer in time', 'B: ok'])
    }
    // a server that ignores "stream": true and sends one JSON body still works
    {
      const net = mkNet(() => new Response(JSON.stringify({ choices: [{ message: { content: 'Plain JSON answer.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      const b = B.createBrain({ file: mk('s6'), fetch: net, now, crypt })
      b.add({ provider: 'groq', key: 'gsk_notstreaming1' })
      const got = []
      const r = await b.chat(msgs, (d) => got.push(d))
      assert.equal(r.ok, true)
      assert.equal(r.text, 'Plain JSON answer.')
      assert.deepEqual(got, ['Plain JSON answer.'])
    }
    // streaming also works against the local model
    {
      const net = mkNet(() => sse(cuts))
      const b = B.createBrain({ file: mk('s5'), fetch: net, now, crypt, ollama: { status: async () => ({ available: true, model: 'qwen2.5:1.5b' }) } })
      const got = []
      const r = await b.chat(msgs, (d) => got.push(d))
      assert.equal(r.ok, true)
      assert.match(r.via, /local Ollama/)
      assert.equal(got.join(''), 'Hello there!')
    }
  }

  // ---------- speech-to-text through Groq Whisper
  {
    const seen = []
    const net = async (url, init = {}) => {
      const key = (init.headers?.Authorization || '').replace('Bearer ', '')
      if (url.endsWith('/audio/transcriptions')) {
        const f = init.body
        seen.push({ key, model: f.get('model'), type: f.get('file').type, size: f.get('file').size, prompt: f.get('prompt'), ctype: init.headers['Content-Type'] })
        if (key === 'KEY_A_whispers1') return new Response('{"error":{"message":"rate"}}', { status: 429 })
        if (f.get('model') === 'whisper-large-v3-turbo' && key === 'KEY_C_whispers3') return new Response('{"error":{"message":"The model does not exist"}}', { status: 404 })
        return new Response(JSON.stringify({ text: '  what is my   cpu ' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }
    const b = B.createBrain({ file: mk('stt'), fetch: net, now, crypt })
    assert.equal(b.canTranscribe(), false)
    assert.equal((await b.transcribe(Buffer.from('RIFF'))).error, 'no Groq key set up')
    b.add({ provider: 'nvidia', key: 'NV_not_groq_1234', label: 'nv' })
    assert.equal(b.canTranscribe(), false, 'only Groq keys can transcribe')
    b.add({ provider: 'groq', key: 'KEY_A_whispers1', label: 'A' })
    b.add({ provider: 'groq', key: 'KEY_B_whispers2', label: 'B' })
    assert.equal(b.canTranscribe(), true)
    const wav = Buffer.alloc(4000, 1)
    const r = await b.transcribe(wav)
    assert.equal(r.ok, true)
    assert.equal(r.text, 'what is my cpu', 'whitespace tidied')
    assert.deepEqual(r.chain, ['A: rate limit reached', 'B: ok'], 'failover between keys, like chat')
    assert.deepEqual(seen.map((s) => s.key), ['KEY_A_whispers1', 'KEY_B_whispers2'])
    assert.equal(seen[1].model, 'whisper-large-v3-turbo')
    assert.equal(seen[1].type, 'audio/wav')
    assert.equal(seen[1].size, 4000)
    assert.match(seen[1].prompt, /Jarvis/)
    assert.equal(seen[1].ctype, undefined, 'multipart boundary is left to fetch')
    // key A is cooling: the next request goes straight to B
    seen.length = 0
    await b.transcribe(wav)
    assert.deepEqual(seen.map((s) => s.key), ['KEY_B_whispers2'])
    // a missing turbo model falls back to the other Whisper model on the same key
    const b2 = B.createBrain({ file: mk('stt2'), fetch: net, now, crypt })
    b2.add({ provider: 'groq', key: 'KEY_C_whispers3', label: 'C' })
    seen.length = 0
    const r2 = await b2.transcribe(wav)
    assert.equal(r2.ok, true)
    assert.deepEqual(seen.map((s) => s.model), ['whisper-large-v3-turbo', 'whisper-large-v3'])
  }

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('brain: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
