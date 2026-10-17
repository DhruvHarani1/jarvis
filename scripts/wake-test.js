'use strict'
// Unit tests for the wake-word supervisor (fake recogniser process), plus a REAL recognition check on synthesized wake phrases (no sound).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const wake = require('../wake')

assert.deepEqual(wake.PHRASES, ['hey jarvis', 'okay jarvis'])
assert.ok(!/\$\{|`/.test(wake.SCRIPT), 'no interpolation hooks in the recogniser script')
assert.match(wake.SCRIPT, /SetInputToDefaultAudioDevice/)
assert.match(wake.SCRIPT, /Confidence -ge \$min/)
assert.ok(!/while \(\$true\) \{\s*\$r = \$e\.Recognize\(/.test(wake.SCRIPT))

/** fake recogniser: speaks the same protocol */
function fake() {
  const proc = { starts: 0, writes: [], children: [] }
  const fn = (_c, _a, opts) => {
    proc.starts++
    proc.env = opts.env
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stdin = { on() {}, write: (s) => proc.writes.push(String(s).trim()) }
    child.kill = () => child.emit('close', 1)
    child.say = (line) => child.stdout.emit('data', line + '\n')
    proc.children.push(child)
    setTimeout(() => child.say('READY'), 2)
    return child
  }
  return { fn, proc }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  // starts, reports state, forwards wake events with their confidence
  {
    const { fn, proc } = fake()
    const states = []
    const wakes = []
    const w = wake.create({ spawn: fn, onWake: (c) => wakes.push(c), onState: (s) => states.push(s), minConfidence: 0.7 })
    w.start()
    await wait(15)
    assert.deepEqual(states, ['starting', 'listening'])
    assert.equal(JSON.parse(Buffer.from(proc.env.SPIDEY_WAKE_PHRASES, 'base64').toString()).includes('hey jarvis'), true)
    assert.equal(proc.env.SPIDEY_WAKE_MIN, '0.7')
    proc.children[0].say('WAKE 0.91')
    await wait(5)
    assert.deepEqual(wakes, [0.91])
    w.stop()
    await wait(10)
    assert.equal(w.state, 'off')
    assert.ok(proc.writes.includes('Q'), 'asked it to quit politely')
  }

  // debounce: one "hey karen" often produces two events; only one wake
  {
    const { fn, proc } = fake()
    let t = 1000
    const wakes = []
    const w = wake.create({ spawn: fn, onWake: (c) => wakes.push(c), now: () => t, debounceMs: 2500 })
    w.start()
    await wait(10)
    const c = proc.children[0]
    c.say('WAKE 0.9')
    await wait(3)
    t += 800
    c.say('WAKE 0.8')
    await wait(3)
    assert.equal(wakes.length, 1)
    t += 3000
    c.say('WAKE 0.85')
    await wait(3)
    assert.equal(wakes.length, 2, 'a later wake counts again')
    w.stop()
  }

  // paused: nothing reaches the app even if the process reports a wake; the process is told to pause and resume
  {
    const { fn, proc } = fake()
    const wakes = []
    const w = wake.create({ spawn: fn, onWake: (c) => wakes.push(c), debounceMs: 0 })
    w.start()
    await wait(10)
    w.pause()
    assert.equal(w.paused, true)
    proc.children[0].say('WAKE 0.95')
    await wait(3)
    assert.equal(wakes.length, 0, 'a paused wake word never fires (Jarvis would hear himself)')
    w.resume()
    proc.children[0].say('WAKE 0.95')
    await wait(3)
    assert.equal(wakes.length, 1)
    assert.deepEqual(proc.writes.filter((x) => x === 'P' || x === 'R'), ['P', 'R'])
    w.stop()
  }

  // pausing before the process is ready is applied as soon as it is
  {
    const { fn, proc } = fake()
    const w = wake.create({ spawn: fn, onWake() {} })
    w.start()
    w.pause()
    await wait(10)
    assert.ok(proc.writes.includes('P'))
    w.stop()
  }

  // a crash restarts it (a few times), then it gives up with a reason instead of looping forever
  {
    const { fn, proc } = fake()
    const states = []
    const w = wake.create({ spawn: fn, onWake() {}, onState: (s, d) => states.push([s, d]), restartMs: 5 })
    w.start()
    await wait(10)
    proc.children[0].kill()
    await wait(25)
    assert.equal(proc.starts, 2, 'restarted once after the crash')
    for (let i = 0; i < 6 && w.state !== 'failed'; i++) {
      proc.children.at(-1).kill()
      await wait(25)
    }
    assert.equal(w.state, 'failed')
    assert.ok(proc.starts <= 6, 'bounded restarts: ' + proc.starts)
    assert.match(states.at(-1)[1], /keeps stopping/)
  }

  // the recogniser itself says it cannot use the microphone: report that reason, do not restart
  {
    const { fn, proc } = fake()
    const states = []
    const w = wake.create({ spawn: fn, onWake() {}, onState: (s, d) => states.push([s, d]), restartMs: 5 })
    w.start()
    await wait(5)
    const c = proc.children[0]
    c.say('FAILED No audio input device is available')
    c.kill()
    await wait(20)
    assert.equal(proc.starts, 1)
    assert.deepEqual(states.at(-1), ['failed', 'No audio input device is available'])
  }

  // ---- REAL recogniser, fed from WAV files instead of the microphone (nothing is played aloud)
  const dir = path.join(__dirname, '..', 'scratch', 'wake-wavs')
  if (fs.existsSync(dir)) {
    const hear = (file) =>
      new Promise((resolve) => {
        const wakes = []
        const w = wake.create({ onWake: (c) => wakes.push(c), minConfidence: 0.6, env: { SPIDEY_WAKE_WAV: path.join(dir, file) } })
        w.start()
        setTimeout(() => {
          w.stop()
          resolve(wakes)
        }, 7000)
      })
    const yes = ['wake-hey-david.wav', 'wake-okay-david.wav', 'wake-okay-zira.wav']
    const no = ['not-wake1-david.wav', 'not-wake2-zira.wav', 'not-wake3-david.wav', 'not-wake4-zira.wav']
    const results = await Promise.all([...yes, ...no].map(async (f) => [f, await hear(f)]))
    for (const [f, hits] of results) {
      if (yes.includes(f)) assert.ok(hits.length >= 1 && hits[0] >= 0.6, `${f} should wake her, got ${JSON.stringify(hits)}`)
      else assert.equal(hits.length, 0, `${f} must NOT wake her, got ${JSON.stringify(hits)}`)
    }
    console.log('real recogniser: woke on', yes.length, 'wake phrases, stayed quiet on', no.length, 'ordinary sentences')
  } else console.log('(wake wavs not generated; skipping the real recogniser check)')

  console.log('wake: ALL PASS')
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
