'use strict'
// Unit tests for tools/rescue.js: tool calls that models write as text are recovered; look-alikes are left alone.
const assert = require('node:assert/strict')
const { rescue } = require('../tools/rescue')

const known = ['set_volume', 'open_app']
const names = (r) => r.calls.map((c) => c.name)
const args = (r, i = 0) => JSON.parse(r.calls[i].arguments)

// 1. Qwen / Hermes
let r = rescue('Sure.<tool_call>{"name": "set_volume", "arguments": {"level": 30}}</tool_call>', known)
assert.deepEqual(names(r), ['set_volume'])
assert.deepEqual(args(r), { level: 30 })
assert.equal(r.text, 'Sure.')
assert.equal(r.dead, false)
r = rescue('<tool_call>\n{"name":"open_app","parameters":{"name":"Spotify"}}\n</tool_call>', known)
assert.deepEqual([names(r), args(r)], [['open_app'], { name: 'Spotify' }])

// 2. Llama function tags (both shapes)
r = rescue('<function=set_volume>{"level": 10}</function>', known)
assert.deepEqual([names(r), args(r)], [['set_volume'], { level: 10 }])
r = rescue('<function=open_app{"name": "Teams"}</function>', known)
assert.deepEqual([names(r), args(r)], [['open_app'], { name: 'Teams' }], 'the shape without ">" is a known Llama variant')

// 3. Kimi / DeepSeek tokens, several calls
r = rescue('<|tool_calls_section_begin|><|tool_call_begin|>functions.open_app:0<|tool_call_argument_begin|>{"name":"Notepad"}<|tool_call_end|><|tool_call_begin|>functions.set_volume:1<|tool_call_argument_begin|>{"level":5}<|tool_call_end|><|tool_calls_section_end|>', known)
assert.deepEqual(names(r), ['open_app', 'set_volume'])
assert.deepEqual(args(r, 1), { level: 5 })
assert.equal(r.text, '')

// 4. bare / fenced: only if it is the whole answer and the name is known
r = rescue('{"name": "set_volume", "arguments": {"level": 50}}', known)
assert.deepEqual(names(r), ['set_volume'])
r = rescue('```json\n{"name": "open_app", "arguments": {"name": "Spotify"}}\n```', known)
assert.deepEqual(names(r), ['open_app'])
r = rescue('{"name": "format_disk", "arguments": {}}', known)
assert.deepEqual([names(r), r.text], [[], '{"name": "format_disk", "arguments": {}}'], 'unknown tool: left as text')
r = rescue('Here is an example: {"name": "set_volume", "arguments": {"level": 50}} as you can see.', known)
assert.deepEqual(names(r), [], 'an object inside a sentence is an explanation, not a call')

// unknown tools inside a dialect are not rescued and the markup is not left to be spoken
r = rescue('<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>', known)
assert.deepEqual(names(r), [])
assert.equal(r.dead, true)

// plain answers are untouched
for (const t of ['It is half past three.', '', 'Use the <b>volume</b> knob.', 'I called a function earlier.']) {
  r = rescue(t, known)
  assert.deepEqual([names(r), r.text, r.dead], [[], t.trim(), false], t)
}
assert.deepEqual(rescue(undefined, known).calls, [])
assert.deepEqual(names(rescue('<tool_call>{bad json}</tool_call>', known)), [])

console.log('tools-rescue: ALL PASS')
