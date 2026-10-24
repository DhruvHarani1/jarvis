'use strict'
// Unit tests for tools/schema.js, tools/audit.js, tools/runtime.js: validation, tiers, confirmation, taint, power mode, audit, undo.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validate } = require('../tools/schema')
const auditMod = require('../tools/audit')
const { createRuntime } = require('../tools/runtime')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tools-test-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

;(async () => {
  // ---------------------------------------------------------------- schema
  const S = {
    type: 'object',
    properties: { level: { type: 'integer', minimum: 0, maximum: 100 }, name: { type: 'string', maxLength: 5 }, mode: { type: 'string', enum: ['a', 'b'] }, on: { type: 'boolean' } },
    required: ['level']
  }
  assert.deepEqual(validate(S, { level: 30 }), { ok: true, value: { level: 30 } })
  for (const [bad, re] of [
    [{}, /level is required/],
    [{ level: 101 }, /at most 100/],
    [{ level: -1 }, /at least 0/],
    [{ level: 3.5 }, /whole number/],
    [{ level: '30' }, /must be a number/],
    [{ level: NaN }, /must be a number/],
    [{ level: 1, extra: 1 }, /not an allowed argument/],
    [{ level: 1, name: 'toolong' }, /too long/],
    [{ level: 1, name: 'a\0b' }, /invalid character/],
    [{ level: 1, mode: 'c' }, /one of a, b/],
    [{ level: 1, on: 'yes' }, /true or false/],
    [null, /must be an object/],
    [[1], /must be an object/],
    [{ level: 1, __proto__: { x: 1 } }, null]
  ]) {
    const r = validate(S, bad)
    if (re) assert.ok(!r.ok && re.test(r.error), JSON.stringify(bad) + ' -> ' + JSON.stringify(r))
  }
  assert.equal(validate(S, JSON.parse('{"level":1,"__proto__":{"x":1}}')).ok, false, 'a __proto__ key from JSON is an unknown argument and is refused')

  // ---------------------------------------------------------------- audit: redaction, rotation, tail
  {
    const file = path.join(tmp, 'a', 'audit.jsonl')
    const a = auditMod.create({ file, now: () => 0 })
    a.log({ tool: 'x', args: { apiKey: 'sk-secret', token: 't', text: 'y'.repeat(300), nested: { password: 'p', ok: 1 } } })
    const e = a.tail(1)[0]
    assert.equal(e.args.apiKey, '***')
    assert.equal(e.args.token, '***')
    assert.equal(e.args.nested.password, '***')
    assert.equal(e.args.nested.ok, 1)
    assert.ok(e.args.text.length < 260 && e.args.text.includes('…(+100)'))
    assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-secret'))
    for (let i = 0; i < 3; i++) a.log({ tool: 'n' + i })
    assert.deepEqual(a.tail(2).map((x) => x.tool), ['n1', 'n2'])
    fs.writeFileSync(file, 'x'.repeat(auditMod.MAX_BYTES + 10))
    a.log({ tool: 'after-rotate' })
    assert.ok(fs.existsSync(file + '.1'), 'old log kept')
    assert.equal(a.tail(5).at(-1).tool, 'after-rotate')
    assert.deepEqual(auditMod.create({ file: path.join(tmp, 'none.jsonl') }).tail(), [])
  }

  // ---------------------------------------------------------------- runtime
  const entries = []
  const asked = []
  let answer = true
  let power = false
  let off = []
  const rt = createRuntime({
    audit: { log: (e) => entries.push(e) },
    confirm: async (req) => (asked.push(req), answer),
    powerMode: () => power,
    disabled: () => off
  })
  let vol = 50
  rt.register({
    name: 'set_volume',
    tier: 'T1',
    description: 'Set volume',
    schema: { type: 'object', properties: { level: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['level'] },
    run: async ({ level }) => {
      const prev = vol
      vol = level
      return { spoken: `Volume ${level}`, undo: async () => ((vol = prev), { spoken: `Volume back to ${prev}` }), undoLabel: 'volume change' }
    }
  })
  rt.register({ name: 'read_time', tier: 'T0', schema: { type: 'object', properties: {} }, run: async () => ({ spoken: 'noon' }) })
  let deleted = []
  rt.register({
    name: 'delete_file',
    tier: 'T2',
    title: 'Delete a file',
    schema: { type: 'object', properties: { path: { type: 'string', maxLength: 300 } }, required: ['path'] },
    describe: (a) => `Move to the Recycle Bin: ${a.path}`,
    run: async ({ path: p }) => (deleted.push(p), { spoken: 'Deleted' })
  })
  let shellRan = 0
  rt.register({ name: 'run_powershell', tier: 'T3', schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, run: async () => (shellRan++, { spoken: 'ran' }) })
  rt.register({ name: 'boom', tier: 'T0', schema: { type: 'object', properties: {} }, run: async () => Promise.reject(new Error('it broke')) })

  // registration is strict
  assert.throws(() => rt.register({ name: 'Bad Name', tier: 'T0', schema: { type: 'object' }, run() {} }), /bad tool name/)
  assert.throws(() => rt.register({ name: 'x_y', tier: 'T9', schema: { type: 'object' }, run() {} }), /bad tier/)
  assert.throws(() => rt.register({ name: 'read_time', tier: 'T0', schema: { type: 'object' }, run() {} }), /already registered/)

  // T0/T1 run without asking, are logged, arguments may arrive as JSON text
  let r = await rt.call('read_time', {})
  assert.deepEqual([r.ok, r.spoken], [true, 'noon'])
  r = await rt.call('set_volume', '{"level": 30}')
  assert.deepEqual([r.ok, r.spoken, vol], [true, 'Volume 30', 30])
  assert.equal(asked.length, 0, 'T0/T1 never ask')
  assert.equal(entries.at(-1).decision, 'allow')
  assert.equal(entries.at(-1).source, 'agent')

  // refusals: unknown tool, bad JSON, bad args; all logged, nothing runs
  for (const [name, args, re] of [
    ['format_disk', {}, /no such tool/],
    ['set_volume', '{nope', /not valid JSON/],
    ['set_volume', { level: 500 }, /at most 100/],
    ['set_volume', { level: 5, evil: 1 }, /not an allowed/]
  ]) {
    r = await rt.call(name, args)
    assert.ok(!r.ok && r.denied && re.test(r.error), name + JSON.stringify(r))
    assert.equal(entries.at(-1).decision, 'denied')
  }
  assert.equal(vol, 30)

  // specs hand the model only what it may use
  let names = rt.specs().map((s) => s.function.name)
  assert.ok(names.includes('set_volume') && names.includes('delete_file'))
  assert.ok(!names.includes('run_powershell'), 'T3 is invisible while power mode is off')
  assert.ok(rt.specs().every((s) => s.type === 'function' && s.function.parameters.type === 'object'))
  off = ['read_time']
  assert.ok(!rt.specs().some((s) => s.function.name === 'read_time'), 'switched-off tools are hidden')
  r = await rt.call('read_time', {})
  assert.ok(r.denied && /switched off/.test(r.error), 'and cannot be called either')
  off = []

  // undo
  assert.equal(rt.undoLabel(), 'volume change')
  r = await rt.undo()
  assert.deepEqual([r.ok, vol, r.spoken], [true, 50, 'Volume back to 50'])
  r = await rt.undo()
  assert.deepEqual([r.ok, r.error], [false, 'there is nothing to undo'])

  // T2: asks every time, with the exact details; "no" means nothing happens
  answer = false
  r = await rt.call('delete_file', { path: 'C:\\Users\\me\\Desktop\\a.txt' })
  assert.ok(!r.ok && r.declined)
  assert.deepEqual(deleted, [])
  assert.equal(asked.at(-1).detail, 'Move to the Recycle Bin: C:\\Users\\me\\Desktop\\a.txt')
  assert.equal(asked.at(-1).requireClick, false)
  assert.equal(entries.at(-1).decision, 'declined')
  answer = true
  r = await rt.call('delete_file', { path: 'C:\\x\\b.txt' })
  assert.ok(r.ok)
  assert.deepEqual(deleted, ['C:\\x\\b.txt'])
  assert.equal(entries.at(-1).decision, 'confirmed')

  // taint: untrusted text in the conversation means a click is required
  await rt.call('delete_file', { path: 'C:\\x\\c.txt' }, { tainted: true })
  assert.equal(asked.at(-1).requireClick, true)

  // a confirm() that throws counts as "no"
  const rt2 = createRuntime({ audit: { log() {} }, confirm: async () => Promise.reject(new Error('dialog gone')) })
  rt2.register({ name: 'danger', tier: 'T2', schema: { type: 'object', properties: {} }, run: async () => ({ spoken: 'did it' }) })
  assert.ok((await rt2.call('danger', {})).declined)

  // T3 only with power mode, and always asks with a click
  r = await rt.call('run_powershell', { command: 'whoami' })
  assert.ok(r.denied && /power mode is off/.test(r.error))
  assert.equal(shellRan, 0)
  power = true
  assert.ok(rt.specs().some((s) => s.function.name === 'run_powershell'))
  r = await rt.call('run_powershell', { command: 'whoami' })
  assert.ok(r.ok && shellRan === 1)
  assert.equal(asked.at(-1).requireClick, true, 'T3 always needs a click')
  assert.equal(asked.at(-1).tier, 'T3')
  power = false

  // a tool that throws: reported and logged, runtime keeps working
  r = await rt.call('boom', {})
  assert.deepEqual([r.ok, r.error], [false, 'it broke'])
  assert.equal(entries.at(-1).ok, false)

  // a tool can hide itself until what it needs exists (a connected account)
  let connected = false
  rt.register({ name: 'needs_account', tier: 'T0', enabled: () => connected, schema: { type: 'object', properties: {} }, run: async () => ({ spoken: 'hi' }) })
  assert.ok(!rt.specs().some((x) => x.function.name === 'needs_account'))
  assert.ok((await rt.call('needs_account', {})).denied)
  connected = true
  assert.ok(rt.specs().some((x) => x.function.name === 'needs_account'))
  assert.ok((await rt.call('needs_account', {})).ok)

  // every registered tool is in the tier list
  assert.deepEqual(rt.tiers().find((t) => t.name === 'delete_file'), { name: 'delete_file', tier: 'T2' })

  console.log('tools-runtime: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
