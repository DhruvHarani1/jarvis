'use strict'
// Piper voice through sherpa-onnx 2.0 + external GPL phonemizer (piper-phonemize-node, installed in models-dev/pp, NOT a project dependency).
//   node scripts/spikes/spike-piper.js <voice-dir-name> <onnx-file> [threads]
const path = require('node:path')
const sherpa = require('sherpa-onnx-node')
const M = path.join(__dirname, '..', '..', 'models-dev')
const phon = require(path.join(M, 'pp', 'node_modules', 'piper-phonemize-node'))
const [dir, onnx, threads = '1'] = process.argv.slice(2)
const d = path.join(M, dir)
const tts = new sherpa.OfflineTts({ model: { vits: { model: path.join(d, onnx), tokens: path.join(d, 'tokens.txt') }, numThreads: +threads, provider: 'cpu' }, maxNumSentences: 1 })
console.log('rss after load', Math.round(process.memoryUsage().rss / 1048576), 'MB; lang', tts.lang, 'sr', tts.sampleRate)
function say(text) {
  const t0 = Date.now()
  const phonemeCodepoints = phon.phonemize(text, tts.lang || 'en-us').filter((s) => s.length > 0)
  const t1 = Date.now()
  const a = tts.generate({ text: '', generationConfig: new sherpa.GenerationConfig({ phonemeCodepoints, sid: 0, speed: 1.0, silenceScale: 0.2 }) })
  const secs = a.samples.length / a.sampleRate
  console.log(`"${text.slice(0, 40)}": phonemize ${t1 - t0} ms, synth ${Date.now() - t1} ms, audio ${secs.toFixed(2)} s, RTF ${((Date.now() - t1) / 1000 / secs).toFixed(2)}`)
  return a
}
say('Warm up.')
const a = say('Good afternoon, sir. It is half past three, and you have two meetings today.')
say('Hey Jarvis, what is the time right now?')
require('node:fs').mkdirSync(path.join(M, 'out'), { recursive: true })
sherpa.writeWave(path.join(M, 'out', `${dir}.wav`), { samples: a.samples, sampleRate: a.sampleRate })
console.log('final rss', Math.round(process.memoryUsage().rss / 1048576), 'MB')
