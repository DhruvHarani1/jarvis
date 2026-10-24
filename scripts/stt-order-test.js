'use strict'
// Order of speech recognition engines: most accurate first (Groq Whisper), then this PC, then Windows; private mode never leaves the PC.
const assert = require('node:assert/strict')
const stt = require('../stt')
const VC = require('../renderer/voice-core')

const wav = Buffer.from(VC.encodeWav(new Float32Array(8000).fill(0.1), 16000))
const local = (text, order) => async () => (order.push('local'), text ? { ok: true, text } : { ok: false, error: 'nothing' })
const brain = (ok, order) => ({ canTranscribe: () => true, transcribe: async () => (order.push('groq'), ok ? { ok: true, text: 'cloud text', via: 'k', chain: ['k: ok'] } : { ok: false, chain: ['k: down'] }) })
stt._setSpawn(() => { throw new Error('windows recogniser must not run in this test') })

;(async () => {
  let order = []
  let r = await stt.transcribe(wav, { mode: 'auto', brain: brain(true, order), local: local('local text', order) })
  assert.deepEqual([r.text, order], ['cloud text', ['groq']], 'auto: Groq Whisper first, the local model is not even loaded')
  assert.match(r.via, /Groq Whisper/)

  order = []
  r = await stt.transcribe(wav, { mode: 'auto', brain: brain(false, order), local: local('local text', order) })
  assert.deepEqual([r.text, order, r.via], ['local text', ['groq', 'local'], 'Moonshine (on this PC)'], 'Groq down: this PC answers')
  assert.deepEqual(r.chain, ['k: down', 'local: ok'])

  order = []
  r = await stt.transcribe(wav, { mode: 'offline', brain: brain(true, order), local: local('local text', order) })
  assert.deepEqual([r.text, order], ['local text', ['local']], 'private mode: only this PC, the cloud is never asked')

  order = []
  r = await stt.transcribe(wav, { mode: 'auto', local: local('local text', order) })
  assert.deepEqual([r.text, order], ['local text', ['local']], 'no Groq key: this PC')

  console.log('stt-order: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
