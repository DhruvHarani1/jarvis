'use strict'
// Wake word sweep on SYNTHETIC speech (Piper voice at several speeds and pitches, quiet to loud, clean to noisy) against ordinary talk and
// look-alike phrases. It shows how the keyword spotter's boost and threshold trade missed wake-ups for false ones. Real voices will differ:
// the numbers say which direction to go, the Voice Lab gives the real ones.
//   node scripts/spikes/wake-sweep.js            (writes scratch/wake-sweep.json)
const fs = require('node:fs')
const path = require('node:path')
const sherpa = require('sherpa-onnx-node')
const models = require('../../audio/models')
const engine = require('../../audio/engine')
const pcm = require('../../audio/pcm')

const root = path.join(__dirname, '..', '..')
const e = engine.create({ sherpa, models, requirePhonemizer: (d) => require(d) })
const kwsDir = models.locate('wake')
const tok = (n) => path.join(kwsDir, `${n}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`)

// ---- seeded random so every run sees the same test set
let seed = 12345
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd())

const rmsOf = (a) => {
  let s = 0
  for (const v of a) s += v * v
  return Math.sqrt(s / Math.max(1, a.length))
}
function degrade(x, { gain = 1, snr = Infinity, pitch = 1 }) {
  let y = pitch === 1 ? x : pcm.resample(x, Math.round(16000 * pitch), 16000)
  const peak = Math.max(...y.map(Math.abs)) || 1
  y = Float32Array.from(y, (v) => (v / peak) * 0.8 * gain)
  const r = rmsOf(y)
  const lead = 12000
  const out = new Float32Array(y.length + lead * 2)
  out.set(y, lead)
  if (Number.isFinite(snr)) {
    const n = r / Math.pow(10, snr / 20)
    for (let i = 0; i < out.length; i++) out[i] += gauss() * n
  } else for (let i = 0; i < out.length; i++) out[i] += gauss() * 0.0005
  return out
}
const speak = (text, speed) => {
  const t = e.synth(text, { speed })
  return pcm.resample(t.samples, t.rate, 16000)
}

// ---- test set
const positives = []
const phrases = ['Hey Jarvis', 'Okay Jarvis', 'Hey Jarvis, what is the time?']
for (const phrase of phrases) {
  for (const speed of [0.85, 1.2]) {
    const base = speak(phrase, speed)
    for (const pitch of [0.9, 1.0, 1.12]) {
      for (const [gain, snr, cond] of [[1, Infinity, 'clean'], [0.08, Infinity, 'quiet'], [0.4, 10, 'noisy 10 dB'], [0.4, 4, 'noisy 4 dB']]) {
        if (phrase.includes('time') && cond !== 'clean' && cond !== 'noisy 10 dB') continue
        positives.push({ cond, phrase, wav: degrade(base, { gain, snr, pitch }) })
      }
    }
  }
}
const talk = [
  'The meeting is at three and I still need to finish the report.', 'Can you please send the invoice to the accountant tomorrow morning?', 'I think the service was great but the food was cold.',
  'Hey Davis, did you see the game last night?', 'Okay, let me think about that for a minute.', 'My name is Travis and I work with Jarvis the dog.', 'Hey Jervis, wait for me!',
  'The weather is lovely today, we should go for a walk by the river.', 'Turn left at the next junction and then keep going straight.', 'He said the price of the new phone is far too high.',
  'Hey service, can I get the bill please?', 'Okay everyone, welcome to the show and thanks for watching.', 'I forgot my keys on the table next to the window.',
  'There are many reasons why this approach is better than the old one.', 'Please remember to switch off the lights when you leave the office.',
  'Okay Travis, we can start now.', 'Hey Harvey, how was your holiday in Spain?', 'That is a very nice car, is it new or second hand?', 'Jarvis is the butler in the film and he talks very politely.',
  'We should order some food, I am starving after the long drive.', 'Hey there, how are you doing this evening?', 'The train to London leaves from platform nine in ten minutes.',
  'I will call you back after lunch, I am in a meeting right now.', 'Okay, so the first thing we need to do is open the file and read it carefully.'
]
const negatives = []
for (const [i, text] of talk.entries()) {
  const speed = i % 2 ? 1.1 : 0.95
  negatives.push({ text, wav: degrade(speak(text, speed), { gain: 0.5 + 0.5 * rnd(), snr: i % 3 === 0 ? 12 : Infinity, pitch: 0.95 + 0.1 * rnd() }) })
}
const negSeconds = negatives.reduce((n, x) => n + x.wav.length / 16000, 0)
console.log(`${positives.length} wake-word clips, ${negatives.length} talk clips (${(negSeconds / 60).toFixed(1)} min)`)

// ---- spotter per configuration
const KW = {
  A: ['▁HE Y ▁JA R VI S', '▁OKAY ▁JA R VI S'],
  B: ['▁HE Y ▁JA R VI S', '▁OKAY ▁JA R VI S', '▁HI ▁JA R VI S', '▁O K ▁JA R VI S', '▁JA R VI S']
}
function makeSpotter(set, boost, thr, global = 0.25) {
  const f = path.join(root, 'scratch', `kw-${set}-${boost}-${thr}.txt`)
  fs.writeFileSync(f, KW[set].map((t, i) => `${t} :${boost} #${thr} @K${i}`).join('\n') + '\n')
  return new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: tok('encoder'), decoder: tok('decoder'), joiner: tok('joiner') }, tokens: path.join(kwsDir, 'tokens.txt'), numThreads: 1, provider: 'cpu' },
    keywordsFile: f,
    keywordsScore: 1.0,
    keywordsThreshold: global
  })
}
function hits(kws, wav) {
  const s = kws.createStream()
  let n = 0
  for (let i = 0; i < wav.length; i += 1600) {
    s.acceptWaveform({ sampleRate: 16000, samples: wav.subarray(i, i + 1600) })
    while (kws.isReady(s)) {
      kws.decode(s)
      if (kws.getResult(s).keyword) n++
    }
  }
  s.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(8000) })
  while (kws.isReady(s)) {
    kws.decode(s)
    if (kws.getResult(s).keyword) n++
  }
  return n
}

const results = []
for (const set of ['A', 'B']) {
  for (const boost of [2, 3.5]) {
    for (const thr of [0.05, 0.1, 0.2, 0.3]) {
      const kws = makeSpotter(set, boost, thr)
      const byCond = {}
      let hit = 0
      for (const p of positives) {
        const h = hits(kws, p.wav) > 0
        hit += h
        const c = (byCond[p.cond] ||= { n: 0, hit: 0 })
        c.n++
        c.hit += h
      }
      let fp = 0
      const fpWhich = []
      for (const n of negatives) {
        const h = hits(kws, n.wav)
        fp += h
        if (h) fpWhich.push(n.text.slice(0, 28))
      }
      const row = { set, boost, thr, recall: hit / positives.length, byCond: Object.fromEntries(Object.entries(byCond).map(([k, v]) => [k, +(v.hit / v.n).toFixed(2)])), falseWakes: fp, perHour: +((fp / negSeconds) * 3600).toFixed(1), fpWhich }
      results.push(row)
      console.log(`set ${set} boost ${boost} thr ${thr}: recall ${(row.recall * 100).toFixed(0)}%  ${JSON.stringify(row.byCond)}  false wakes ${fp} (${row.perHour}/h) ${fpWhich.length ? JSON.stringify(fpWhich) : ''}`)
    }
  }
}
fs.writeFileSync(path.join(root, 'scratch', 'wake-sweep.json'), JSON.stringify({ positives: positives.length, negSeconds, results }, null, 1))
