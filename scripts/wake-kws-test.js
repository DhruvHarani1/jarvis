'use strict'
// Unit tests for wake-kws.js (the on-PC "Hey Jarvis" adapter): states, pausing, debounce, microphone failure.
const assert = require('node:assert/strict')
const wakeKws = require('../wake-kws')

function rig() {
  const sent = []
  const fed = []
  const woke = []
  const states = []
  let wakeCb = null
  let active = null
  let t = 1000
  const audio = {
    feedWake: (s) => fed.push(s.length),
    setWakeActive: (on) => (active = on),
    onWake: (cb) => (wakeCb = cb)
  }
  const w = wakeKws.create({ audio, send: (c, p) => sent.push([c, p]), onWake: (k) => woke.push(k), onState: (s, d) => states.push(d ? [s, d] : s), now: () => t })
  return { w, sent, fed, woke, states, fire: (k = 'HEY_JARVIS') => wakeCb(k), tick: (ms) => (t += ms), get active() { return active } }
}

// start asks the window for the microphone; listening only once the window says it has it
{
  const r = rig()
  assert.equal(r.w.state, 'off')
  r.w.start()
  assert.equal(r.w.state, 'starting')
  assert.deepEqual(r.sent, [['wake:enable', true]])
  assert.equal(r.active, true)
  r.w.pcm(new Float32Array(100))
  assert.deepEqual(r.fed, [], 'samples before the microphone is confirmed are ignored')
  r.w.mic({ ok: true })
  assert.equal(r.w.state, 'listening')
  r.w.pcm(new Float32Array(100))
  assert.deepEqual(r.fed, [100])
  // junk is refused
  r.w.pcm([1, 2, 3])
  r.w.pcm(new Float32Array(0))
  r.w.pcm(new Float32Array(20000))
  assert.deepEqual(r.fed, [100], 'only sensible Float32 chunks reach the model')
}

// detection: reported once, debounced, ignored while paused
{
  const r = rig()
  r.w.start()
  r.w.mic({ ok: true })
  r.fire()
  assert.deepEqual(r.woke, ['HEY_JARVIS'])
  r.tick(500)
  r.fire()
  assert.equal(r.woke.length, 1, 'a second event within a moment is the same "hey jarvis"')
  r.tick(3000)
  r.w.pause()
  assert.equal(r.w.state, 'paused')
  assert.deepEqual(r.sent.at(-1), ['wake:pause', true])
  r.fire()
  assert.equal(r.woke.length, 1, 'nothing is detected while he is speaking or listening')
  r.w.pcm(new Float32Array(100))
  assert.equal(r.fed.length, 0, 'no audio is analysed while paused')
  r.w.resume()
  assert.equal(r.w.state, 'listening')
  assert.deepEqual(r.sent.at(-1), ['wake:pause', false])
  r.fire()
  assert.equal(r.woke.length, 2)
}

// stop closes the window's microphone; resume/pause when off do nothing
{
  const r = rig()
  r.w.pause()
  r.w.resume()
  assert.equal(r.w.state, 'off')
  r.w.start()
  r.w.mic({ ok: true })
  r.w.stop()
  assert.equal(r.w.state, 'off')
  assert.deepEqual(r.sent.at(-1), ['wake:enable', false])
  assert.equal(r.active, false)
  r.fire()
  assert.equal(r.woke.length, 0)
}

// microphone refused: state failed with the reason, worker allowed to sleep
{
  const r = rig()
  r.w.start()
  r.w.mic({ ok: false, error: 'microphone blocked in Windows privacy settings' })
  assert.equal(r.w.state, 'failed')
  assert.deepEqual(r.states.at(-1), ['failed', 'microphone blocked in Windows privacy settings'])
  assert.equal(r.active, false)
  r.w.start() // can be tried again
  assert.equal(r.w.state, 'starting')
}

console.log('wake-kws: ALL PASS')
