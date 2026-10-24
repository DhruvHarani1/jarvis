'use strict'
// The smart wake word: segmentation of speech from silence and the hand-over of the command, with a fake speech model.
const assert = require('node:assert/strict')
const asr = require('../wake-asr')

const R = 16000
const room = (secs, amp = 0.003) => Float32Array.from({ length: Math.round(R * secs) }, () => (Math.random() - 0.5) * amp)
const talk = (secs, amp = 0.12) => Float32Array.from({ length: Math.round(R * secs) }, (_, i) => amp * Math.sin(i / 7) * (0.7 + 0.3 * Math.sin(i / 1500)))
const cat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const feedAll = (w, samples, chunk = 1600) => {
  for (let i = 0; i < samples.length; i += chunk) w.feed(samples.subarray(i, i + chunk))
}
const tick = () => new Promise((r) => setTimeout(r, 20))

;(async () => {
  // "hey jarvis what is the time" said once, in a quiet room: transcribed once, wakes, hands over the command
  {
    const seen = []
    const woke = []
    const heard = []
    const w = asr.create({ transcribe: async (s) => (seen.push(s.length), 'Hey Jarvis, what is the time?'), onHeard: (t, m) => heard.push([t, m]), onWake: (rest) => woke.push(rest) })
    feedAll(w, cat(room(1.5), talk(2), room(1)))
    await tick()
    assert.equal(seen.length, 1, 'one utterance, one transcription')
    assert.ok(seen[0] > R * 2 && seen[0] < R * 3.5, 'the clip holds the speech with a little room around it: ' + seen[0] / R)
    assert.deepEqual(woke, ['what is the time?'])
    assert.deepEqual(heard, [['Hey Jarvis, what is the time?', true]])
  }
  // ordinary talk: heard (shown on screen) but no wake
  {
    const woke = []
    const heard = []
    const w = asr.create({ transcribe: async () => 'the meeting is at three', onHeard: (t, m) => heard.push([t, m]), onWake: () => woke.push(1) })
    feedAll(w, cat(room(1), talk(1.5), room(1)))
    await tick()
    assert.equal(woke.length, 0)
    assert.equal(heard[0][1], false)
  }
  // silence and clicks never reach the model
  {
    let calls = 0
    const w = asr.create({ transcribe: async () => (calls++, 'x'), onWake: () => {} })
    feedAll(w, cat(room(3), talk(0.1), room(2)))
    await tick()
    assert.equal(calls, 0, 'a 100 ms click is not speech')
  }
  // two utterances in a row, a noisy room (floor 0.02): both found
  {
    const woke = []
    let n = 0
    const w = asr.create({ transcribe: async () => (++n === 1 ? 'hello there' : 'okay jarvis open spotify'), onWake: (r) => woke.push(r) })
    feedAll(w, cat(room(2, 0.04), talk(1.2, 0.2), room(1, 0.04), talk(1.5, 0.2), room(1, 0.04)))
    await tick()
    await tick()
    assert.deepEqual(woke, ['open spotify'])
  }
  // very long talk is cut into pieces instead of waiting for a pause that never comes
  {
    let calls = 0
    const w = asr.create({ transcribe: async () => (calls++, 'blah'), onWake: () => {} })
    feedAll(w, cat(room(0.5), talk(20), room(1)))
    await tick()
    assert.ok(calls >= 2, 'cut at about 9 s: ' + calls)
  }
  // a broken model does not stop the listening
  {
    const errors = []
    const woke = []
    let n = 0
    const w = asr.create({ transcribe: async () => { if (++n === 1) throw new Error('boom'); return 'hey jarvis' }, onWake: () => woke.push(1), onError: (e) => errors.push(e.message) })
    feedAll(w, cat(room(1), talk(1), room(1), talk(1), room(1)))
    await tick()
    await tick()
    assert.deepEqual(errors, ['boom'])
    assert.equal(woke.length, 1)
  }
  console.log('wake-asr: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
