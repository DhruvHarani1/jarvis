'use strict'
// Tool calling through the brain: tools are sent, structured calls come back (JSON body and streamed fragments), half-written calls are dropped.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const B = require('../brain')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tools-test-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
const crypt = { available: () => true, enc: (s) => Buffer.from(s).toString('base64'), dec: (s) => Buffer.from(s, 'base64').toString() }
const TOOLS = [{ type: 'function', function: { name: 'set_volume', description: 'v', parameters: { type: 'object', properties: { level: { type: 'integer' } } } } }]
const msgs = [{ role: 'user', content: 'volume 30' }]

function net(handler) {
  const seen = []
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fake-model' }] }), { status: 200 })
    seen.push(body)
    return handler(body)
  }
  fn.seen = seen
  return fn
}
const sse = (events) =>
  new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const mkBrain = (fetchFn, name) => {
  const b = B.createBrain({ file: path.join(tmp, name + '.json'), fetch: fetchFn, now: () => 1_000_000, crypt })
  b.add({ provider: 'custom', key: 'KEY_12345678', label: 'fake', baseUrl: 'https://fake.example/v1', model: 'fake-model' })
  return b
}

;(async () => {
  // non-streamed: tools are in the request, the structured call comes back, no text needed
  {
    const f = net(() => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_volume', arguments: '{"level":30}' } }] } }] }), { status: 200 }))
    const r = await mkBrain(f, 'plain').chat(msgs, undefined, { tools: TOOLS })
    assert.equal(r.ok, true)
    assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'set_volume', arguments: '{"level":30}' }])
    assert.equal(r.text, '')
    assert.deepEqual(f.seen[0].tools, TOOLS)
    assert.equal(f.seen[0].tool_choice, 'auto')
  }

  // without tools nothing about tools is sent
  {
    const f = net(() => new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 }))
    const r = await mkBrain(f, 'notools').chat(msgs)
    assert.deepEqual([r.ok, r.text, r.toolCalls], [true, 'hello', []])
    assert.equal(f.seen[0].tools, undefined)
  }

  // streamed fragments are put back together, in index order, with text before them still delivered
  {
    const f = net(() =>
      sse([
        { choices: [{ delta: { content: 'On it. ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'set_vol', arguments: '{"lev' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'open_app', arguments: '{"name":"Spotify"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ume', arguments: 'el":30}' } }] } }] },
        '[DONE]'
      ])
    )
    const deltas = []
    const r = await mkBrain(f, 'stream').chat(msgs, (t) => deltas.push(t), { tools: TOOLS })
    assert.equal(r.ok, true)
    assert.deepEqual(deltas, ['On it. '])
    assert.deepEqual(r.toolCalls, [
      { id: 'a', name: 'set_volume', arguments: '{"level":30}' },
      { id: 'b', name: 'open_app', arguments: '{"name":"Spotify"}' }
    ])
  }

  // a stream that is only tool calls is a success
  {
    const f = net(() => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'set_volume', arguments: '{"level":5}' } }] } }] }, '[DONE]']))
    const r = await mkBrain(f, 'onlytools').chat(msgs, () => {}, { tools: TOOLS })
    assert.deepEqual([r.ok, r.text, r.toolCalls.length], [true, '', 1])
  }

  // streaming server that ignores stream:true and answers with a JSON body containing tool calls
  {
    const f = net(() => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'j', function: { name: 'set_volume', arguments: { level: 9 } } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const r = await mkBrain(f, 'jsonbody').chat(msgs, () => {}, { tools: TOOLS })
    assert.deepEqual(r.toolCalls, [{ id: 'j', name: 'set_volume', arguments: '{"level":9}' }], 'object arguments are turned into JSON text')
  }

  // a stream that dies in the middle of a tool call: partial text is kept, the half call is dropped (never run)
  {
    const enc = new TextEncoder()
    let pulls = 0
    const body = new ReadableStream({
      pull(c) {
        pulls++
        if (pulls === 1) {
          c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Sure. ' } }] }) + '\n\n'))
          c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'z', function: { name: 'set_volume', arguments: '{"le' } }] } }] }) + '\n\n'))
        } else c.error(new Error('connection reset'))
      }
    })
    const f = net(() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const r = await mkBrain(f, 'dies').chat(msgs, () => {}, { tools: TOOLS })
    assert.deepEqual([r.ok, r.text, r.toolCalls], [true, 'Sure.', []])
  }

  console.log('brain-tools: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
