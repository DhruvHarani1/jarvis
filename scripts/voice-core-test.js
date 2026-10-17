'use strict'
// Unit tests for the WAV encoder, resampler and speech start/stop detector.
const assert = require('node:assert/strict')
const V = require('../renderer/voice-core.js')

// ---- WAV container
{
  const wav = V.encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]), 16000)
  const dv = new DataView(wav.buffer)
  const tag = (o) => String.fromCharCode(...wav.slice(o, o + 4))
  assert.equal(tag(0), 'RIFF')
  assert.equal(tag(8), 'WAVE')
  assert.equal(tag(12), 'fmt ')
  assert.equal(tag(36), 'data')
  assert.equal(dv.getUint32(4, true), wav.length - 8)
  assert.equal(dv.getUint16(20, true), 1, 'PCM')
  assert.equal(dv.getUint16(22, true), 1, 'mono')
  assert.equal(dv.getUint32(24, true), 16000)
  assert.equal(dv.getUint32(28, true), 32000)
  assert.equal(dv.getUint16(34, true), 16)
  assert.equal(dv.getUint32(40, true), 14)
  assert.equal(wav.length, 44 + 14)
  assert.equal(dv.getInt16(44, true), 0)
  assert.ok(dv.getInt16(46, true) > 16000 && dv.getInt16(46, true) < 16500)
  assert.equal(dv.getInt16(50, true), 0x7fff, 'full scale positive')
  assert.equal(dv.getInt16(52, true), -0x8000, 'full scale negative')
  assert.equal(dv.getInt16(54, true), 0x7fff, 'over-range is clipped, not wrapped')
  assert.equal(dv.getInt16(56, true), -0x8000)
}
assert.equal(V.encodeWav(new Float32Array(0)).length, 44, 'an empty recording is still a valid header')

// ---- resampling keeps the duration
{
  const a = V.resample(new Float32Array(48000), 48000, 16000)
  assert.equal(a.length, 16000)
  const b = V.resample(new Float32Array(44100), 44100, 16000)
  assert.ok(Math.abs(b.length - 16000) <= 1)
  const same = V.resample(Float32Array.from([1, 2, 3]), 16000, 16000)
  assert.deepEqual([...same], [1, 2, 3])
  // a ramp stays a ramp (linear interpolation)
  const ramp = Float32Array.from({ length: 300 }, (_, i) => i / 300)
  const r = V.resample(ramp, 48000, 16000)
  assert.ok(r.every((x, i) => i === 0 || x >= r[i - 1]))
  assert.equal(V.resample(new Float32Array(0), 48000, 16000).length, 0)
}
assert.equal(V.rms(Float32Array.from([0.5, -0.5, 0.5, -0.5])), 0.5)
assert.equal(V.rms(new Float32Array(0)), 0)

// ---- detector: feed it loudness readings, 20 ms apart
const run = (levels, opts) => {
  const vad = V.createVad(opts)
  const events = []
  levels.forEach((lv, i) => vad.feed(lv, 20).forEach((e) => events.push([e, (i + 1) * 20])))
  return events
}
const rep = (n, v) => Array(n).fill(v)
{
  // quiet room, then a spoken phrase (400 ms), then silence: 'speech' then 'end' ~1.1 s after they stop
  const ev = run([...rep(15, 0.004), ...rep(20, 0.08), ...rep(80, 0.004)])
  assert.deepEqual(ev.map((e) => e[0]), ['speech', 'end'])
  assert.ok(ev[0][1] <= 15 * 20 + 7 * 20, 'speech detected within ~140 ms of starting')
  const endAt = ev[1][1]
  assert.ok(endAt >= (15 + 20) * 20 + 1100 && endAt <= (15 + 20) * 20 + 1200, 'ends ~1.1 s after they stop, got ' + endAt)

  // a short pause inside a sentence does not cut them off
  const mid = run([...rep(15, 0.004), ...rep(15, 0.08), ...rep(25, 0.004), ...rep(15, 0.08), ...rep(80, 0.004)])
  assert.deepEqual(mid.map((e) => e[0]), ['speech', 'end'])
  assert.ok(mid[1][1] > (15 + 15 + 25 + 15) * 20, 'the 0.5 s pause did not end the recording')

  // a click shorter than 100 ms is not speech
  assert.deepEqual(run([...rep(15, 0.004), 0.2, 0.2, ...rep(400, 0.004)], { noSpeechMs: 3000 }).map((e) => e[0]), ['nospeech'])

  // nobody speaks
  const none = run(rep(500, 0.004))
  assert.deepEqual(none.map((e) => e[0]), ['nospeech'])
  assert.ok(none[0][1] >= 6000 && none[0][1] <= 6100)

  // someone who never stops talking is cut at the maximum
  const long = run([...rep(15, 0.004), ...rep(1000, 0.08)], { maxMs: 4000 })
  assert.deepEqual(long.map((e) => e[0]), ['speech', 'timeout'])

  // a noisy room: the threshold adapts to the noise floor, so steady noise is not "speech"
  const noisy = run([...rep(15, 0.05), ...rep(300, 0.05)], { noSpeechMs: 2000 })
  assert.deepEqual(noisy.map((e) => e[0]), ['nospeech'])
  // ...but speech well above that floor still is
  const loudRoom = run([...rep(15, 0.05), ...rep(20, 0.4), ...rep(80, 0.05)])
  assert.deepEqual(loudRoom.map((e) => e[0]), ['speech', 'end'])

  // after an end nothing more is reported
  const vad = V.createVad()
  let all = []
  for (let i = 0; i < 400; i++) all.push(...vad.feed(i < 15 ? 0.004 : i < 40 ? 0.1 : 0.004, 20))
  assert.deepEqual(all, ['speech', 'end'])
}

console.log('voice-core: ALL PASS')
