'use strict'
// Spike C: RAM and speed of local voice models (sherpa-onnx-node). Run: node scripts/spikes/spike-c.js
// Models live in models-dev/ (git-ignored; see PLAN.md M0 results for sources and checksums).
const path = require('node:path')
const fs = require('node:fs')
const sherpa = require('sherpa-onnx-node')
const M = path.join(__dirname, '..', '..', 'models-dev')
const mb = () => Math.round(process.memoryUsage().rss / 1048576)
const log = (...a) => console.log(...a)
const time = (label, fn) => { const t = Date.now(); const r = fn(); log(`  ${label}: ${Date.now() - t} ms`); return r }

log('baseline RSS', mb(), 'MB')

// --- TTS: Kokoro int8 en v0.19
const kdir = path.join(M, 'kokoro-int8-en-v0_19')
const tts = time('load kokoro', () => new sherpa.OfflineTts({
  model: { kokoro: { model: path.join(kdir, 'model.int8.onnx'), voices: path.join(kdir, 'voices.bin'), tokens: path.join(kdir, 'tokens.txt'), lexicon: path.join(M, 'lexicon-en-us.txt') }, numThreads: +(process.env.TTS_THREADS || 2), provider: 'cpu' },
  maxNumSentences: 1
}))
log('RSS after kokoro load', mb(), 'MB; speakers', tts.numSpeakers)
const phrase = 'Hey Jarvis, what is the time right now?'
let audio
for (let i = 0; i < 2; i++) {
  const t = Date.now()
  audio = tts.generate({ text: phrase, sid: 0, speed: 1.0 })
  const secs = audio.samples.length / audio.sampleRate
  log(`  kokoro synth #${i + 1}: ${Date.now() - t} ms for ${secs.toFixed(2)} s audio (RTF ${((Date.now() - t) / 1000 / secs).toFixed(2)})`)
}
fs.mkdirSync(path.join(M, 'out'), { recursive: true })
sherpa.writeWave(path.join(M, 'out', 'kokoro-hey-jarvis.wav'), { samples: audio.samples, sampleRate: audio.sampleRate })
log('RSS after kokoro synth', mb(), 'MB')

// --- TTS: Piper skipped on purpose: sherpa-onnx 2.0 dropped built-in espeak; Piper needs an external (GPL) phonemizer and the library segfaults without one.

// --- STT: streaming zipformer 20M, fed the kokoro output (resampled by the library)
const zdir = path.join(M, 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17')
const online = time('load streaming zipformer', () => new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: path.join(zdir, 'encoder-epoch-99-avg-1.int8.onnx'), decoder: path.join(zdir, 'decoder-epoch-99-avg-1.int8.onnx'), joiner: path.join(zdir, 'joiner-epoch-99-avg-1.int8.onnx') }, tokens: path.join(zdir, 'tokens.txt'), numThreads: 2, provider: 'cpu' }
}))
function streamDecode(samples, rate) {
  const s = online.createStream()
  s.acceptWaveform({ sampleRate: rate, samples })
  s.acceptWaveform({ sampleRate: rate, samples: new Float32Array(rate * 0.4) })
  while (online.isReady(s)) online.decode(s)
  return online.getResult(s).text
}
{
  const t = Date.now()
  const w = sherpa.readWave(path.join(zdir, 'test_wavs', '0.wav'))
  const txt = streamDecode(w.samples, w.sampleRate)
  log(`  zipformer test wav (${(w.samples.length / w.sampleRate).toFixed(1)} s): ${Date.now() - t} ms -> "${txt}"`)
  const t2 = Date.now()
  log(`  zipformer on kokoro audio: ${Date.now() - t2} ms -> "${streamDecode(audio.samples, audio.sampleRate)}"`)
}
log('RSS after zipformer', mb(), 'MB')

// --- STT: moonshine base en (offline)
const mdir = path.join(M, 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27')
const off = time('load moonshine base', () => new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { moonshine: { encoder: path.join(mdir, 'encoder_model.ort'), mergedDecoder: path.join(mdir, 'decoder_model_merged.ort') }, tokens: path.join(mdir, 'tokens.txt'), numThreads: 2, provider: 'cpu' }
}))
function offDecode(samples, rate) {
  const s = off.createStream()
  s.acceptWaveform({ sampleRate: rate, samples })
  off.decode(s)
  return off.getResult(s).text
}
{
  const w = sherpa.readWave(path.join(zdir, 'test_wavs', '0.wav'))
  const t = Date.now()
  log(`  moonshine test wav: ${Date.now() - t} ms -> "${offDecode(w.samples, w.sampleRate)}" (took ${Date.now() - t} ms)`)
  const t2 = Date.now()
  log(`  moonshine on kokoro audio -> "${offDecode(audio.samples, audio.sampleRate)}" (${Date.now() - t2} ms)`)
}
log('RSS after moonshine', mb(), 'MB')

// --- VAD
const vad = new sherpa.Vad({ sileroVad: { model: path.join(M, 'silero_vad_v5.onnx'), threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.5, windowSize: 512 }, sampleRate: 16000, numThreads: 1, debug: false }, 30)
log('vad ok; RSS', mb(), 'MB')

// --- KWS: try several tokenisations of "hey jarvis" (no sentencepiece available, so guess BPE splits)
const kdir2 = path.join(M, 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01')
const kwFile = path.join(M, 'out', 'keywords-test.txt')
const cands = ['▁HE Y ▁JA R V IS', '▁HE Y ▁JA R V I S', '▁HE Y ▁J AR V IS', '▁HE Y ▁J AR V I S', '▁HE Y ▁JA R V IS @HEY_JARVIS_A']
const tokens = new Set(fs.readFileSync(path.join(kdir2, 'tokens.txt'), 'utf8').split('\n').map((l) => l.split(' ')[0]))
const usable = cands.filter((c) => c.split(' ').filter((t) => !t.startsWith('@')).every((t) => tokens.has(t)))
log('usable keyword tokenisations:', usable)
fs.writeFileSync(kwFile, usable.map((u, i) => `${u.split(' @')[0]} @CAND${i}`).join('\n') + '\n')
try {
  const kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: path.join(kdir2, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'), decoder: path.join(kdir2, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'), joiner: path.join(kdir2, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx') }, tokens: path.join(kdir2, 'tokens.txt'), numThreads: 1, provider: 'cpu' },
    keywordsFile: kwFile
  })
  const s = kws.createStream()
  s.acceptWaveform({ sampleRate: audio.sampleRate, samples: audio.samples })
  s.acceptWaveform({ sampleRate: audio.sampleRate, samples: new Float32Array(audio.sampleRate * 0.5) })
  const hits = []
  while (kws.isReady(s)) { kws.decode(s); const k = kws.getResult(s).keyword; if (k) hits.push(k) }
  log('KWS hits on kokoro "Hey Jarvis...":', hits)
  log('RSS after kws', mb(), 'MB')
} catch (e) { log('KWS error', e.message) }
log('final RSS', mb(), 'MB')
