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
  assert.deepEqual(r.chain, ['k: down', 'Moonshine (on this PC): ok'])

  order = []
  r = await stt.transcribe(wav, { mode: 'offline', brain: brain(true, order), local: local('local text', order) })
  assert.deepEqual([r.text, order], ['local text', ['local']], 'private mode: only this PC, the cloud is never asked')

  order = []
  r = await stt.transcribe(wav, { mode: 'auto', local: local('local text', order) })
  assert.deepEqual([r.text, order], ['local text', ['local']], 'no Groq key: this PC')

  // several engines on this PC: the best first, a failing, empty or nonsense answer falls through to the next
  const eng = (name, fn, order) => ({ name, run: async () => (order.push(name), fn()) })
  order = []
  r = await stt.transcribe(wav, { mode: 'offline', locals: [eng('Parakeet', () => ({ ok: true, text: 'what is my cpu' }), order), eng('Moonshine', () => ({ ok: true, text: 'x' }), order)] })
  assert.deepEqual([r.text, r.via, order], ['what is my cpu', 'Parakeet', ['Parakeet']], 'the best engine answers, the others are not touched')
  order = []
  r = await stt.transcribe(wav, { mode: 'offline', locals: [eng('Parakeet', () => ({ ok: true, text: '' }), order), eng('Moonshine', () => ({ ok: true, text: 'open spotify' }), order)] })
  assert.deepEqual([r.text, r.via, order], ['open spotify', 'Moonshine', ['Parakeet', 'Moonshine']], 'empty answer: next engine')
  assert.deepEqual(r.chain, ['Parakeet: heard nothing', 'Moonshine: ok'])
  order = []
  r = await stt.transcribe(wav, { mode: 'offline', locals: [eng('Parakeet', () => { throw new Error('model not installed') }, order), eng('Moonshine', () => ({ ok: true, text: 'volume thirty' }), order)] })
  assert.deepEqual([r.text, r.chain[0]], ['volume thirty', 'Parakeet: model not installed'], 'a crashing engine does not stop the chain')

  // nonsense from near-silence is not accepted; the same words from a loud recording are
  const quiet = Buffer.from(VC.encodeWav(new Float32Array(16000).fill(0.002), 16000))
  assert.equal(stt.usable('Thank you.', stt.wavLevel(quiet)), false, 'a stock phrase out of near-silence is a hallucination')
  assert.equal(stt.usable('Thank you.', stt.wavLevel(wav)), true, 'a real "thank you" in a loud recording is kept')
  for (const [t, ok] of [['', false], ['...', false], ['  ', false], ['open spotify', true], ['you', true], ['42', true]]) assert.equal(stt.usable(t, 1), ok, JSON.stringify(t))
  order = []
  r = await stt.transcribe(quiet, { mode: 'offline', locals: [eng('Parakeet', () => ({ ok: true, text: 'Thank you.' }), order), eng('Moonshine', () => ({ ok: true, text: 'you' }), order)] })
  assert.equal(r.ok, false, 'both engines only made up a stock phrase from silence, so there is no answer')
  order = []
  r = await stt.transcribe(quiet, { mode: 'auto', brain: { canTranscribe: () => true, transcribe: async () => ({ ok: true, text: 'Thank you.', via: 'k', chain: ['k: ok'] }) }, locals: [eng('Parakeet', () => ({ ok: true, text: 'turn the lights on' }), order)] })
  assert.deepEqual([r.text, r.via], ['turn the lights on', 'Parakeet'], 'cloud nonsense falls through to this PC')

  console.log('stt-order: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
