'use strict'
// Unit tests for tools/scheduler.js (timers and reminders) with a fake clock.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const scheduler = require('../tools/scheduler')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sched-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
const file = path.join(dir, 'reminders.json')

function rig(startAt = 1_000_000) {
  let t = startAt
  const timers = []
  const fired = []
  const s = scheduler.create({
    file,
    now: () => t,
    setTimer: (fn, ms) => {
      const x = { fn, at: t + ms }
      timers.push(x)
      return x
    },
    clearTimer: (x) => {
      const i = timers.indexOf(x)
      if (i >= 0) timers.splice(i, 1)
    },
    onFire: (r) => fired.push(r)
  })
  const advance = (ms) => {
    t += ms
    for (const x of [...timers].filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(x), 1)
      x.fn()
    }
  }
  return { s, fired, advance, timers, set: (v) => (t = v), get now() { return t } }
}

// add, list, fire once, removed after firing
{
  const r = rig()
  r.s.start()
  const a = r.s.add({ at: r.now + 5 * 60_000, text: 'stand up' })
  const b = r.s.add({ at: r.now + 60_000, text: 'tea' })
  assert.ok(a.ok && b.ok && a.id !== b.id)
  assert.deepEqual(r.s.list().map((x) => x.text), ['tea', 'stand up'], 'sorted by time')
  r.advance(61_000)
  assert.deepEqual(r.fired.map((x) => [x.text, x.late]), [['tea', false]])
  assert.deepEqual(r.s.list().map((x) => x.text), ['stand up'])
  r.advance(5 * 60_000)
  assert.equal(r.fired.length, 2)
  assert.equal(r.s.list().length, 0)
}

// cancel
{
  const r = rig()
  r.s.start()
  const a = r.s.add({ at: r.now + 60_000, text: 'x' })
  assert.equal(r.s.cancel(a.id), true)
  assert.equal(r.s.cancel(a.id), false)
  r.advance(120_000)
  assert.equal(r.fired.length, 0)
}

// limits
{
  const r = rig()
  r.s.start()
  assert.match(r.s.add({ at: r.now - 60_000, text: 'past' }).error, /passed/)
  assert.match(r.s.add({ at: NaN, text: 'nan' }).error, /passed/)
  assert.match(r.s.add({ at: r.now + 400 * 24 * 3600_000, text: 'far' }).error, /year/)
  for (let i = 0; i < scheduler.MAX_REMINDERS; i++) assert.ok(r.s.add({ at: r.now + 60_000 + i, text: 'n' + i }).ok)
  assert.match(r.s.add({ at: r.now + 90_000, text: 'one too many' }).error, /too many/)
  assert.equal(r.s.add({ at: r.now + 1000, text: 'y'.repeat(500) }).ok, false)
  assert.equal(r.s.list().find((x) => x.text.startsWith('n0')).text.length, 2)
}
fs.rmSync(file, { force: true })

// persistence: survives a restart; one that came due while closed is announced late; a day-old one is dropped silently
{
  const r1 = rig(5_000_000)
  r1.s.start()
  r1.s.add({ at: 5_000_000 + 10 * 60_000, text: 'future' })
  r1.s.add({ at: 5_000_000 + 60_000, text: 'missed while closed' })
  r1.s.add({ at: 5_000_000 + 30_000, text: 'ancient' })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  saved.items.find((x) => x.text === 'ancient').at = 5_000_000 - 3 * 24 * 3600_000
  fs.writeFileSync(file, JSON.stringify(saved))
  const r2 = rig(5_000_000 + 3 * 60_000)
  r2.s.start()
  assert.deepEqual(r2.fired.map((x) => [x.text, x.late]), [['missed while closed', true]])
  assert.deepEqual(r2.s.list().map((x) => x.text), ['future'])
  r2.advance(8 * 60_000)
  assert.deepEqual(r2.fired.map((x) => x.text), ['missed while closed', 'future'])
  // ids keep counting up after a restart
  const r3 = rig(5_000_000 + 20 * 60_000)
  r3.s.start()
  const id = r3.s.add({ at: r3.now + 1000, text: 'new' }).id
  assert.ok(id > 3)
}

// a corrupt file starts clean
{
  fs.writeFileSync(file, '{{{ not json')
  const r = rig()
  r.s.start()
  assert.equal(r.s.list().length, 0)
  assert.ok(r.s.add({ at: r.now + 1000, text: 'ok' }).ok)
}

// a listener that throws does not stop the others
{
  fs.rmSync(file, { force: true })
  let t = 0
  const timers = []
  const got = []
  const s = scheduler.create({ file, now: () => t, setTimer: (fn, ms) => (timers.push({ fn, at: t + ms }), timers.at(-1)), clearTimer() {}, onFire: (r) => (got.push(r.text), (() => { throw new Error('listener bug') })()) })
  s.start()
  s.add({ at: 100, text: 'a' })
  s.add({ at: 200, text: 'b' })
  t = 300
  for (const x of timers) x.fn()
  assert.deepEqual(got, ['a', 'b'])
}

console.log('tools-scheduler: ALL PASS')
