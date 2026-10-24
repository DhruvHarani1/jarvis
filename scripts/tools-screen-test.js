'use strict'
// Screen understanding: the tool (hidden until switched on, a click every time, untrusted answers) and brain.vision (picks a model that can see).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const B = require('../brain')
const { createScreenTools } = require('../tools/screen')
const { createRuntime } = require('../tools/runtime')
const { parse } = require('../fastpath')

const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-screen-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

;(async () => {
  // ---- the tool
  let on = false
  const asked = []
  const calls = []
  let visionAnswer = { ok: true, text: 'It shows an error: **disk full**. Free some space.', via: 'groq (llama-4-scout)' }
  const rt = createRuntime({ audit: { log() {} }, confirm: async (r) => (asked.push(r), true) })
  for (const t of createScreenTools({ capture: async () => (calls.push('capture'), PIC), vision: async (p, img) => (calls.push(['vision', p, img]), visionAnswer), enabled: () => on, providers: () => ['Groq', 'Gemini'] })) rt.register(t)
  assert.deepEqual(rt.specs(), [], 'off: the AI model is not offered it')
  assert.ok((await rt.call('look_at_screen', { question: 'what is this?' })).denied)
  assert.deepEqual(calls, [], 'off: no screenshot is ever taken')
  on = true
  assert.deepEqual(rt.specs().map((s) => s.function.name), ['look_at_screen'])
  let r = await rt.call('look_at_screen', { question: 'what does this error say?' }, { source: 'fastpath' })
  assert.ok(r.ok)
  assert.equal(asked.at(-1).tier, 'T2')
  assert.equal(asked.at(-1).requireClick, true, 'a click is always needed, even with nothing untrusted around')
  assert.match(asked.at(-1).detail, /^Send a picture of your main screen to Groq or Gemini so it can answer:\n"what does this error say\?"\n\nEverything visible on that screen goes with it/)
  assert.deepEqual(calls[0], 'capture')
  assert.equal(calls[1][2], PIC)
  assert.match(calls[1][1], /Question: what does this error say\?$/)
  assert.equal(r.spoken, 'It shows an error: disk full. Free some space.', 'markdown marks are removed for speaking')
  assert.equal(r.untrusted, true)
  const n = calls.length
  const rtNo = createRuntime({ audit: { log() {} }, confirm: async () => false })
  for (const t of createScreenTools({ capture: async () => (calls.push('capture2'), PIC), vision: async () => visionAnswer, enabled: () => true, providers: () => [] })) rtNo.register(t)
  assert.ok((await rtNo.call('look_at_screen', { question: 'anything' })).declined)
  assert.equal(calls.length, n, 'no from the user: no screenshot taken')
  visionAnswer = { ok: false, error: 'none of my keys has a model that can look at a picture' }
  assert.match((await rt.call('look_at_screen', { question: 'what is this?' })).error, /model that can look/)
  assert.equal((await rt.call('look_at_screen', { question: 'x' })).ok, false, 'a too-short question is refused')

  // ---- fast path
  for (const text of ['what is on my screen', "what's on my screen", 'look at my screen', 'read my screen', 'what am i looking at']) {
    assert.deepEqual(parse(text), { kind: 'tool', name: 'look_at_screen', args: { question: 'Describe what is on the screen and read out anything important.' } }, text)
  }
  assert.deepEqual(parse('what does this error say'), { kind: 'tool', name: 'look_at_screen', args: { question: 'What does the error message on the screen say, and what should I do about it?' } })

  // ---- brain.vision: only models that can see, with the same keys and limits
  const crypt = { available: () => true, enc: (s) => Buffer.from(s).toString('base64'), dec: (s) => Buffer.from(s, 'base64').toString() }
  const seen = []
  const net = async (url, init = {}) => {
    const key = (init.headers?.Authorization || '').replace('Bearer ', '')
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }, { id: 'meta-llama/llama-4-scout-17b-16e-instruct' }] }), { status: 200 })
    const body = JSON.parse(init.body)
    seen.push({ key, body })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A terminal with an error.' } }] }), { status: 200 })
  }
  const b = B.createBrain({ file: path.join(tmp, 'b.json'), fetch: net, now: () => 1_000_000, crypt })
  b.add({ provider: 'groq', key: 'GROQKEY_aaaaaaaa', label: 'groq' })
  const v = await b.vision('what is this?', PIC)
  assert.deepEqual([v.ok, v.text], [true, 'A terminal with an error.'])
  assert.equal(seen[0].body.model, 'meta-llama/llama-4-scout-17b-16e-instruct', 'the picture went to the model that can see, not the text model or whisper')
  const part = seen[0].body.messages[0].content
  assert.deepEqual([part[0].type, part[1].type, part[1].image_url.url], ['text', 'image_url', PIC])
  assert.equal(b.list()[0].usage.rpdUsed, 1, 'it counts against the key\'s daily use')
  // a key with no vision model
  const noVision = async (url) => (url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }] }), { status: 200 }) : new Response('{}', { status: 500 }))
  const b2 = B.createBrain({ file: path.join(tmp, 'b2.json'), fetch: noVision, now: () => 1_000_000, crypt })
  b2.add({ provider: 'groq', key: 'GROQKEY_bbbbbbbb', label: 'g' })
  const v2 = await b2.vision('what is this?', PIC)
  assert.deepEqual([v2.ok, /no model that can see/.test(v2.chain[0])], [false, true])
  assert.match(v2.error, /model that can look at a picture/)
  assert.equal((await B.createBrain({ file: path.join(tmp, 'b3.json'), fetch: net, now: () => 1, crypt }).vision('x', PIC)).error, 'no AI key to look at the picture with')

  console.log('tools-screen: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
