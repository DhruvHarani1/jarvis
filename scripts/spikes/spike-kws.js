'use strict'
// Spike C2: does the sherpa-onnx keyword spotter find "hey jarvis"? BPE splits are guessed (no sentencepiece here).
const path = require('node:path')
const fs = require('node:fs')
const sherpa = require('sherpa-onnx-node')
const M = path.join(__dirname, '..', '..', 'models-dev')
const d = path.join(M, 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01')
const wav = process.argv[2] || path.join(M, 'out', 'kokoro-hey-jarvis.wav')
const lines = [
  '▁HE Y ▁JA R VI S :2 #0.1 @HEY_JARVIS',
  '▁OKAY ▁JA R VI S :2 #0.1 @OKAY_JARVIS',
  '▁HE Y ▁JA R V IS :2.5 #0.1 @A',
  '▁HE Y ▁JA R V I S :2.5 #0.1 @B',
  '▁HE Y ▁J AR V IS :2.5 #0.1 @C',
  '▁HE Y ▁JA R V IS :4 #0.05 @D',
  '▁HE Y ▁J AR V I S :2.5 #0.1 @E'
].filter((l) => l.split(' :')[0].split(' ').every((t) => fs.readFileSync(path.join(d, 'tokens.txt'), 'utf8').split('\n').some((x) => x.split(' ')[0] === t)))
const f = path.join(M, 'out', 'kw2.txt')
fs.writeFileSync(f, lines.join('\n') + '\n')
const kws = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: path.join(d, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'), decoder: path.join(d, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'), joiner: path.join(d, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx') }, tokens: path.join(d, 'tokens.txt'), numThreads: 1, provider: 'cpu' },
  keywordsFile: f, keywordsScore: 1.0, keywordsThreshold: 0.25
})
const w = sherpa.readWave(wav)
const s = kws.createStream()
s.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples })
s.acceptWaveform({ sampleRate: w.sampleRate, samples: new Float32Array(w.sampleRate * 0.5) })
const hits = []
while (kws.isReady(s)) { kws.decode(s); const r = kws.getResult(s); if (r.keyword) hits.push(r.keyword) }
console.log(wav, 'candidates', lines.length, 'hits', hits)
