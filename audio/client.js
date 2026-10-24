'use strict'
/**
 * Main-process side of the audio worker: starts it on demand, talks to it with request/response messages,
 * and stops it again after a while of doing nothing so the models give their RAM back.
 * A crash of the worker only fails the request in flight; the next request starts a fresh one.
 */
const REQUEST_TIMEOUT = { stt: 60_000, tts: 30_000, default: 15_000 }

/**
 * @param {{fork:(path:string)=>any, workerPath:string, userDir?:string, idleMs?:number, setTimer?:Function, clearTimer?:Function}} o
 */
function create({ fork, workerPath, userDir, idleMs = 120_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let child = null
  let nextId = 1
  const pending = new Map()
  let wakeActive = false
  let wakePreset = 'normal' // remembered so a restarted worker gets it again
  let idleTimer = null
  let onWake = () => {}
  let onCrash = () => {}

  function failAll(msg) {
    for (const [, p] of pending) {
      clearTimer(p.timer)
      p.reject(new Error(msg))
    }
    pending.clear()
  }

  function spawn() {
    if (child) return child
    const c = fork(workerPath)
    child = c
    c.on('message', (m) => {
      if (!m) return
      if (m.event === 'wake') return onWake(m.keyword)
      if (m.event === 'error') return
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      clearTimer(p.timer)
      if (m.ok) p.resolve(m)
      else p.reject(new Error(m.error || 'audio worker error'))
    })
    c.on('exit', (code) => {
      if (child === c) child = null
      failAll('audio worker stopped' + (code ? ` (exit ${code})` : ''))
      if (code) onCrash(code)
    })
    send(c, { id: nextId++, op: 'init', userDir: typeof userDir === 'function' ? userDir() : userDir })
    if (wakePreset !== 'normal') send(c, { id: nextId++, op: 'wake-preset', name: wakePreset })
    return c
  }

  function send(c, msg, transfer) {
    c.postMessage(msg, transfer)
  }

  function armIdle() {
    clearTimer(idleTimer)
    if (!child || wakeActive || !idleMs) return
    idleTimer = setTimer(() => {
      if (!pending.size && !wakeActive) stop()
    }, idleMs)
    if (idleTimer && idleTimer.unref) idleTimer.unref()
  }

  function request(op, payload = {}, timeoutMs) {
    const c = spawn()
    clearTimer(idleTimer)
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(id)
        reject(new Error(`audio worker did not answer (${op})`))
        armIdle()
      }, timeoutMs || REQUEST_TIMEOUT[op] || REQUEST_TIMEOUT.default)
      pending.set(id, {
        resolve: (v) => {
          resolve(v)
          armIdle()
        },
        reject: (e) => {
          reject(e)
          armIdle()
        },
        timer
      })
      send(c, { id, op, ...payload })
    })
  }

  /** @param {Float32Array} samples 16 kHz mono */
  const transcribe = (samples, opts = {}) => request('stt', { samples, model: opts.model, hotwords: opts.hotwords })
  const speak = (text, speed) => request('tts', { text, speed })
  const status = () => request('status')
  const unload = (what) => request('unload', { what })
  const setWakePreset = (name) => {
    wakePreset = name
    return child ? request('wake-preset', { name }) : Promise.resolve({ ok: true })
  }
  const wakeTest = (samples) => request('wake-test', { samples })

  /** microphone samples for the always-on wake word; fire and forget */
  function feedWake(samples) {
    wakeActive = true
    clearTimer(idleTimer)
    send(spawn(), { op: 'wake', samples })
  }
  function setWakeActive(on) {
    wakeActive = !!on
    if (!on) {
      if (child) send(child, { op: 'wake-reset' })
      armIdle()
    }
  }

  function stop() {
    clearTimer(idleTimer)
    const c = child
    child = null
    failAll('audio worker stopped')
    if (c) {
      try {
        c.kill()
      } catch {
        /* already gone */
      }
    }
  }

  return {
    transcribe,
    speak,
    status,
    unload,
    setWakePreset,
    wakeTest,
    feedWake,
    setWakeActive,
    stop,
    onWake: (cb) => (onWake = cb),
    onCrash: (cb) => (onCrash = cb),
    get running() {
      return !!child
    }
  }
}

module.exports = { create, REQUEST_TIMEOUT }
