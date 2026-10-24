'use strict'
// Speed, memory and accuracy of the two on-PC speech models on the same audio: Moonshine base and NVIDIA Parakeet TDT 0.6B.
//   node scripts/spikes/bench-stt.js
const fs = require('node:fs')
const path = require('node:path')
const sherpa = require('sherpa-onnx-node')
const models = require('../../audio/models')
const engine = require('../../audio/engine')
const pcm = require('../../audio/pcm')
const mb = () => Math.round(process.memoryUsage().rss / 1048576)
const e = engine.create({ sherpa, models, requirePhonemizer: (d) => require(d) })
const root = path.join(__dirname, '..', '..')
const clips = []
const w1 = sherpa.readWave(path.join(root, 'models-dev', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'test_wavs', '0.wav'))
clips.push(['librispeech clip', w1.samples])
const mine = path.join(root, 'scratch', 'e2e-last.wav')
if (fs.existsSync(mine)) clips.push(['"what is my cpu" (fake mic, clipped)', pcm.wavToFloat32(fs.readFileSync(mine)).samples])
// computer voice at 3 speeds (a stand-in for different speakers)
for (const [label, speed] of [['piper normal', 1.0], ['piper fast', 1.35], ['piper slow', 0.8]]) {
  const t = e.synth('Hey Jarvis, send a WhatsApp to Asha saying I will be late, and open Spotify.', { speed })
  clips.push([label, pcm.resample(t.samples, t.rate, 16000)])
}
console.log('rss before', mb(), 'MB')
for (const model of ['moonshine', 'parakeet']) {
  for (const hot of model === 'parakeet' ? ['', 'JARVIS/WHATSAPP/SPOTIFY/ASHA'] : ['']) {
    console.log(`\n== ${model}${hot ? ' + hotwords' : ''}`)
    e.transcribe(clips[0][1], { model, hotwords: hot }) // warm up, loads the model
    console.log('  rss after load', mb(), 'MB')
    for (const [label, s] of clips) {
      const r = e.transcribe(s, { model, hotwords: hot })
      console.log(`  ${label.padEnd(36)} ${String(r.ms).padStart(5)} ms for ${r.seconds.toFixed(1)} s (RTF ${(r.ms / 1000 / r.seconds).toFixed(2)})  "${r.text}"`)
    }
  }
}
console.log('\nfinal rss', mb(), 'MB')
