'use strict'
// Kokoro int8 speed vs thread count. node scripts/spikes/spike-tts-threads.js 1 2 4
const path = require('node:path')
const sherpa = require('sherpa-onnx-node')
const M = path.join(__dirname, '..', '..', 'models-dev')
const k = path.join(M, 'kokoro-int8-en-v0_19')
for (const n of process.argv.slice(2).map(Number)) {
  const tts = new sherpa.OfflineTts({ model: { kokoro: { model: path.join(k, 'model.int8.onnx'), voices: path.join(k, 'voices.bin'), tokens: path.join(k, 'tokens.txt'), lexicon: path.join(M, 'lexicon-en-us.txt') }, numThreads: n, provider: 'cpu' }, maxNumSentences: 1 })
  tts.generate({ text: 'Warm up.', sid: 0, speed: 1 })
  const t = Date.now()
  const a = tts.generate({ text: 'It is half past three, and you have two meetings today.', sid: 0, speed: 1 })
  const secs = a.samples.length / a.sampleRate
  console.log(`threads ${n}: ${Date.now() - t} ms for ${secs.toFixed(2)} s audio, RTF ${((Date.now() - t) / 1000 / secs).toFixed(2)}`)
}
