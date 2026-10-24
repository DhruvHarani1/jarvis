'use strict'
// Checks the three wake presets of audio/engine.js (low, normal, high) with the same kind of synthetic clips as wake-sweep.js,
// using the engine's own wakeTest (per-stream keywords). Not a unit test: needs the real models.
//   node scripts/spikes/wake-presets.js
const sherpa = require('sherpa-onnx-node')
const models = require('../../audio/models')
const engine = require('../../audio/engine')
const pcm = require('../../audio/pcm')

const e = engine.create({ sherpa, models, requirePhonemizer: (d) => require(d) })
let seed = 4242
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd())
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length))
const speak = (t, speed) => {
  const r = e.synth(t, { speed })
  return pcm.resample(r.samples, r.rate, 16000)
}
function degrade(x, { gain = 1, snr = Infinity, pitch = 1 }) {
  let y = pitch === 1 ? x : pcm.resample(x, Math.round(16000 * pitch), 16000)
  const peak = Math.max(...y.map(Math.abs)) || 1
  y = Float32Array.from(y, (v) => (v / peak) * 0.8 * gain)
  const out = new Float32Array(y.length + 24000)
  out.set(y, 12000)
  const n = Number.isFinite(snr) ? rms(y) / Math.pow(10, snr / 20) : 0.0005
  for (let i = 0; i < out.length; i++) out[i] += gauss() * n
  return out
}

const pos = []
for (const phrase of ['Hey Jarvis', 'Okay Jarvis']) for (const speed of [0.85, 1.2]) for (const pitch of [0.9, 1, 1.12]) for (const [gain, snr, cond] of [[1, Infinity, 'clean'], [0.08, Infinity, 'quiet'], [0.4, 10, 'noisy 10 dB'], [0.4, 4, 'noisy 4 dB']]) pos.push({ cond, wav: degrade(speak(phrase, speed), { gain, snr, pitch }) })
const talk = ['The meeting is at three and I still need to finish the report.', 'I think the service was great but the food was cold.', 'Hey Davis, did you see the game last night?', 'My name is Travis and I work with Jarvis the dog.', 'Hey Jervis, wait for me!', 'Hey service, can I get the bill please?', 'Okay Travis, we can start now.', 'Hey Harvey, how was your holiday in Spain?', 'Jarvis is the butler in the film and he talks very politely.', 'Okay everyone, welcome to the show and thanks for watching.', 'The train to London leaves from platform nine in ten minutes.', 'Okay, so the first thing we need to do is open the file and read it carefully.']
const neg = talk.map((t, i) => degrade(speak(t, i % 2 ? 1.1 : 0.95), { gain: 0.5 + 0.5 * rnd(), snr: i % 3 === 0 ? 12 : Infinity, pitch: 0.95 + 0.1 * rnd() }))
const negSec = neg.reduce((n, x) => n + x.length / 16000, 0)

const res = {}
for (const name of Object.keys(engine.WAKE_PRESETS)) res[name] = { hit: 0, byCond: {}, fp: 0 }
for (const p of pos) {
  const h = e.wakeTest(p.wav)
  for (const [name, n] of Object.entries(h)) {
    const r = res[name]
    r.hit += n > 0
    const c = (r.byCond[p.cond] ||= [0, 0])
    c[0] += n > 0
    c[1]++
  }
}
for (const w of neg) for (const [name, n] of Object.entries(e.wakeTest(w))) res[name].fp += n
for (const [name, r] of Object.entries(res)) console.log(`${name}: recall ${((r.hit / pos.length) * 100).toFixed(0)}%  ${Object.entries(r.byCond).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(', ')}  false wakes ${r.fp} in ${(negSec / 60).toFixed(1)} min`)
