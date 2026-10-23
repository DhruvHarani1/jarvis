'use strict'
// Tests for tools/windows.js. Part 1 uses fakes only. Part 2 (Windows only) runs the real PowerShell scripts on harmless
// things: reads the volume and sets it to the same value, lists Start-menu apps, reads CPU/battery, and sends a temporary
// file to the Recycle Bin and brings it back.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTools, pickApp, MEDIA_KEYS } = require('../tools/windows')
const { createSandbox } = require('../tools/paths')
const { createRuntime } = require('../tools/runtime')
const psReal = require('../tools/ps')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-win-test-'))
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }))
const docs = path.join(base, 'Documents')
fs.mkdirSync(path.join(docs, 'Projects'), { recursive: true })
fs.mkdirSync(path.join(base, 'Secrets'))
fs.writeFileSync(path.join(docs, 'invoice-march.pdf'), 'x')
fs.writeFileSync(path.join(docs, 'Projects', 'invoice-april.pdf'), 'x')
fs.writeFileSync(path.join(base, 'Secrets', 'invoice-secret.pdf'), 'x')
fs.writeFileSync(path.join(docs, 'run.bat'), 'x')

;(async () => {
  // ---------------------------------------------------------------- pickApp
  const list = [{ name: 'Spotify', id: 'a' }, { name: 'Microsoft Teams', id: 'b' }, { name: 'Notepad', id: 'c' }, { name: 'Notepad++', id: 'd' }, { name: 'Outlook (new)', id: 'e' }, { name: 'Settings', id: 'f' }]
  assert.equal(pickApp(list, 'spotify').id, 'a')
  assert.equal(pickApp(list, 'the spotify').id, 'a')
  assert.equal(pickApp(list, 'teams').id, 'b', 'a word inside a longer name')
  assert.equal(pickApp(list, 'notepad').id, 'c', 'exact beats prefix')
  assert.equal(pickApp(list, 'outlook').id, 'e')
  assert.equal(pickApp(list, 'photoshop'), null)
  assert.equal(pickApp(list, '   '), null)

  // ---------------------------------------------------------------- fakes
  const calls = []
  let volume = { level: 40, muted: false }
  const ps = async (script, arg) => {
    calls.push(arg)
    if (script.includes('Get-StartApps')) return JSON.stringify(list)
    if (script.includes('::SetMute([bool]')) return JSON.stringify((volume = { ...volume, muted: arg.muted }))
    if (script.includes('::Set([int]')) return JSON.stringify((volume = { ...volume, level: arg.level }))
    if (script.includes('::Get(); muted')) return JSON.stringify(volume)
    if (script.includes('LoadPercentage')) return JSON.stringify({ cpu: 12, battery: 80, charging: true })
    return 'ok'
  }
  const opened = { urls: [], paths: [] }
  let clip = 'old'
  const scheduled = []
  let nextId = 1
  const scheduler = { add: (r) => (scheduled.push(r), { ok: true, id: nextId++ }), cancel: (id) => id < nextId, list: () => scheduled.map((r, i) => ({ id: i + 1, ...r })) }
  const sandbox = createSandbox([docs])
  const tools = createTools({
    ps,
    shell: { openExternal: async (u) => opened.urls.push(u), openPath: async (p) => (opened.paths.push(p), '') },
    clipboard: { readText: () => clip, writeText: (t) => (clip = t) },
    scheduler,
    sandbox,
    fs,
    os: { totalmem: () => 1000, freemem: () => 250, uptime: () => 7300 },
    folder: (n) => (n === 'documents' ? docs : null),
    now: () => 1_000_000
  })
  const asked = []
  const rt = createRuntime({ audit: { log() {} }, confirm: async (r) => (asked.push(r), true) })
  for (const t of tools) rt.register(t)
  const call = (n, a) => rt.call(n, a)

  // every tool is registered, tiers are what the plan says
  const tiers = Object.fromEntries(rt.tiers().map((t) => [t.name, t.tier]))
  assert.deepEqual(tiers, {
    open_app: 'T1', open_url: 'T1', set_volume: 'T1', mute: 'T1', media_key: 'T1', set_timer: 'T1', add_reminder: 'T1', list_reminders: 'T0', cancel_reminder: 'T1',
    read_clipboard: 'T0', write_clipboard: 'T1', system_status: 'T0', find_files: 'T0', open_file: 'T1', move_file: 'T2', delete_file: 'T2'
  })
  assert.ok(!rt.names().some((n) => /shell|powershell|run_|exec|registry/.test(n)), 'no shell-like tool exists with power mode off')

  // open_app
  let r = await call('open_app', { name: 'Teams' })
  assert.deepEqual([r.ok, r.spoken], [true, 'Opening Microsoft Teams.'])
  assert.deepEqual(calls.at(-1), { id: 'b' })
  r = await call('open_app', { name: 'photoshop' })
  assert.match(r.spoken, /could not find/)

  // open_url: only web addresses
  assert.ok((await call('open_url', { url: 'https://www.youtube.com/watch?v=1' })).ok)
  assert.deepEqual(opened.urls, ['https://www.youtube.com/watch?v=1'])
  for (const bad of ['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'ms-settings:network', 'https://user:pw@evil.example/', 'not a url at all', 'ftp://x.example/a']) {
    r = await call('open_url', { url: bad })
    assert.equal(r.ok, false, bad)
  }
  assert.equal(opened.urls.length, 1)

  // volume with undo, mute with undo
  r = await call('set_volume', { level: 80 })
  assert.deepEqual([r.ok, r.spoken, volume.level], [true, 'Volume 80.', 80])
  assert.equal((await rt.undo()).spoken, 'Volume back to 40.')
  assert.equal(volume.level, 40)
  r = await call('mute', { muted: true })
  assert.equal(volume.muted, true)
  await rt.undo()
  assert.equal(volume.muted, false)
  assert.equal((await call('set_volume', { level: 101 })).ok, false)

  // media keys
  await call('media_key', { action: 'next', times: 2 })
  assert.deepEqual(calls.slice(-2), [{ vk: MEDIA_KEYS.next }, { vk: MEDIA_KEYS.next }])
  assert.equal((await call('media_key', { action: 'format_c' })).ok, false)
  assert.equal((await call('media_key', { action: 'next', times: 50 })).ok, false)

  // timers and reminders
  r = await call('set_timer', { minutes: 10, label: 'tea' })
  assert.match(r.spoken, /Timer set for 10 minutes/)
  assert.deepEqual(scheduled.at(-1), { at: 1_000_000 + 600_000, text: 'Your tea timer is up.' })
  await call('add_reminder', { text: 'call mum', in_minutes: 30 })
  assert.equal(scheduled.at(-1).at, 1_000_000 + 1_800_000)
  r = await call('add_reminder', { text: 'x', at: 'not a date' })
  assert.match(r.error, /understand that date/)
  r = await call('add_reminder', { text: 'x' })
  assert.match(r.error, /say when/)
  assert.ok((await call('list_reminders', {})).spoken.includes('call mum'))

  // clipboard: reading is flagged untrusted, writing is undoable
  r = await call('read_clipboard', {})
  assert.deepEqual([r.data.text, r.untrusted], ['old', true])
  await call('write_clipboard', { text: 'new' })
  assert.equal(clip, 'new')
  await rt.undo()
  assert.equal(clip, 'old')

  // system status
  r = await call('system_status', {})
  assert.match(r.spoken, /CPU 12 percent, memory 75 percent, battery 80 percent, charging, up for 2 hours/)

  // find_files: stays in the sandbox, flags results as untrusted
  r = await call('find_files', { query: 'INVOICE' })
  assert.deepEqual(r.data.map((x) => path.basename(x.path)).sort(), ['invoice-april.pdf', 'invoice-march.pdf'])
  assert.equal(r.untrusted, true)
  assert.ok(!JSON.stringify(r.data).includes('Secrets'))
  r = await call('find_files', { query: 'nothing-like-this' })
  assert.deepEqual([r.data.length, r.untrusted], [0, false])

  // open_file: sandbox, no programs
  assert.ok((await call('open_file', { path: path.join(docs, 'invoice-march.pdf') })).ok)
  assert.deepEqual(opened.paths, [path.join(docs, 'invoice-march.pdf')])
  assert.match((await call('open_file', { path: path.join(docs, 'run.bat') })).error, /do not open programs/)
  assert.match((await call('open_file', { path: path.join(base, 'Secrets', 'invoice-secret.pdf') })).error, /outside/)
  assert.match((await call('open_file', { path: path.join(docs, 'missing.pdf') })).error, /does not exist/)

  // move_file: T2 (asked), sandbox both ends, never overwrites, undo moves back
  const a = path.join(docs, 'invoice-march.pdf')
  const b = path.join(docs, 'Projects', 'march-moved.pdf')
  r = await call('move_file', { from: a, to: b })
  assert.ok(r.ok)
  assert.equal(asked.at(-1).tier, 'T2')
  assert.match(asked.at(-1).detail, /Move\n.*invoice-march\.pdf\nto\n.*march-moved\.pdf/)
  assert.ok(!fs.existsSync(a) && fs.existsSync(b))
  assert.equal((await rt.undo()).spoken, 'Moved back.')
  assert.ok(fs.existsSync(a) && !fs.existsSync(b))
  assert.match((await call('move_file', { from: a, to: path.join(base, 'Secrets', 'out.pdf') })).error, /outside/)
  assert.match((await call('move_file', { from: path.join(base, 'Secrets', 'invoice-secret.pdf'), to: path.join(docs, 'in.pdf') })).error, /outside/)
  assert.match((await call('move_file', { from: a, to: path.join(docs, 'Projects', 'invoice-april.pdf') })).error, /overwrite/)
  assert.match((await call('move_file', { from: path.join(docs, 'Projects'), to: path.join(docs, 'P2') })).error, /only move files/)

  // delete_file: T2, files only, never a protected root, sandbox
  const delCalls = calls.length
  assert.match((await call('delete_file', { path: docs })).error, /only delete single files|protected/)
  assert.match((await call('delete_file', { path: path.join(base, 'Secrets', 'invoice-secret.pdf') })).error, /outside/)
  assert.match((await call('delete_file', { path: path.join(docs, 'missing.txt') })).error, /does not exist/)
  assert.equal(calls.length, delCalls, 'nothing reached PowerShell for refused deletions')
  r = await call('delete_file', { path: path.join(docs, 'run.bat') })
  assert.ok(r.ok && /Recycle Bin/.test(r.spoken))
  assert.deepEqual(calls.at(-1), { path: path.join(docs, 'run.bat') })

  // ---------------------------------------------------------------- real PowerShell on harmless things (Windows only)
  if (process.platform !== 'win32') return console.log('tools-windows: ALL PASS (real PowerShell part skipped)')
  const real = createTools({
    ps: (s, a) => psReal.run(s, a, { timeoutMs: 40_000 }),
    shell: { openExternal: async () => {}, openPath: async () => '' },
    clipboard: { readText: () => '', writeText() {} },
    scheduler,
    sandbox: createSandbox([docs]),
    fs,
    os,
    folder: () => docs
  })
  const rrt = createRuntime({ audit: { log() {} }, confirm: async () => true })
  for (const t of real) rrt.register(t)

  const st = await rrt.call('system_status', {})
  assert.ok(st.ok && /CPU \d+ percent/.test(st.spoken), 'real status: ' + JSON.stringify(st))

  const vol0 = await psReal.run(require('../tools/windows').PS.audioGet, undefined, { timeoutMs: 40_000 })
  const before = JSON.parse(vol0)
  assert.ok(before.level >= 0 && before.level <= 100, 'real volume read: ' + vol0)
  const sv = await rrt.call('set_volume', { level: before.level }) // same value: audible change none
  assert.ok(sv.ok && sv.data.level === before.level, 'real volume set: ' + JSON.stringify(sv))
  assert.ok((await rrt.call('mute', { muted: before.muted })).ok, 'real mute set to the current state')

  const oa = await rrt.call('open_app', { name: 'zzzz-no-such-app-zzzz' })
  assert.match(oa.spoken, /could not find/, 'real Start-menu list was read: ' + JSON.stringify(oa))

  // real Recycle Bin round trip
  const victim = path.join(docs, 'jarvis-recycle-test-' + process.pid + '.txt')
  fs.writeFileSync(victim, 'delete me')
  const del = await rrt.call('delete_file', { path: victim })
  assert.ok(del.ok, 'real delete: ' + JSON.stringify(del))
  assert.ok(!fs.existsSync(victim), 'the file left its folder')
  const un = await rrt.undo()
  assert.ok(un.ok, 'real restore: ' + JSON.stringify(un))
  assert.equal(fs.readFileSync(victim, 'utf8'), 'delete me', 'the file is back with its content')

  console.log('tools-windows: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
