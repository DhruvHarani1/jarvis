'use strict'
/**
 * Audio worker: runs in an Electron utilityProcess so a native crash or a memory leak in the models can never take the
 * app down, and so the whole process can be killed to give RAM back.
 *
 * parent -> worker   { id, op: 'init', userDir }   { id, op: 'stt', samples }   { id, op: 'tts', text, speed }
 *                    { op: 'wake', samples }        { op: 'wake-reset' }          { id, op: 'unload', what }   { id, op: 'status' }
 * worker -> parent   { id, ok, ...result }          { event: 'wake', keyword }
 */
const models = require('./models')
const engine = require('./engine')

let eng = null
const port = process.parentPort
const reply = (id, body) => port.postMessage({ id, ...body })

function ensure() {
  if (eng) return eng
  eng = engine.create({
    sherpa: require('sherpa-onnx-node'),
    models,
    requirePhonemizer: (dir) => require(dir)
  })
  return eng
}

const f32 = (x) => (x instanceof Float32Array ? x : new Float32Array(x))

port.on('message', (ev) => {
  const m = ev.data || {}
  try {
    if (m.op === 'init') {
      if (m.userDir) models.setUserDir(m.userDir)
      return reply(m.id, { ok: true, pid: process.pid })
    }
    if (m.op === 'stt') return reply(m.id, { ok: true, ...ensure().transcribe(f32(m.samples)) })
    if (m.op === 'tts') {
      const r = ensure().synth(m.text, { speed: m.speed })
      return reply(m.id, { ok: true, samples: r.samples, rate: r.rate, ms: r.ms })
    }
    if (m.op === 'wake') {
      const hit = ensure().feedWake(f32(m.samples))
      if (hit) port.postMessage({ event: 'wake', keyword: hit })
      return
    }
    if (m.op === 'wake-reset') return ensure().resetWake()
    if (m.op === 'unload') {
      ensure().unload(m.what)
      return reply(m.id, { ok: true })
    }
    if (m.op === 'status') return reply(m.id, { ok: true, loaded: ensure().loaded(), rssMB: Math.round(process.memoryUsage().rss / 1048576) })
    reply(m.id, { ok: false, error: 'unknown op' })
  } catch (e) {
    if (m.id !== undefined) reply(m.id, { ok: false, error: String((e && e.message) || e) })
    else port.postMessage({ event: 'error', error: String((e && e.message) || e) })
  }
})
