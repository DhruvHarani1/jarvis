'use strict'
/**
 * "Hey Jarvis" with the on-PC keyword spotter (sherpa-onnx, in the audio worker). Same interface as wake.js (the Windows
 * speech-recogniser version), so main.js can use either.
 *
 * The window keeps the microphone open while this is on and streams 16 kHz samples here; they go straight to the worker,
 * are never stored and never leave the PC. While Jarvis is listening to a question or speaking, the stream is paused
 * (he must not wake himself up with his own voice).
 */
const DEBOUNCE_MS = 2500

/**
 * @param {{audio:{feedWake:(s:Float32Array)=>void, setWakeActive:(on:boolean)=>void, onWake:(cb:(k:string)=>void)=>void}, send:(channel:string, payload?:any)=>void, onWake:()=>void, onState?:(state:string, detail?:string)=>void, now?:()=>number}} o
 */
function create({ audio, send, onWake, onState = () => {}, now = Date.now }) {
  let state = 'off' // off | starting | listening | paused | failed
  let lastWake = -Infinity

  const set = (s, detail) => {
    if (state === s && !detail) return
    state = s
    onState(s, detail)
  }

  audio.onWake((keyword) => {
    if (state !== 'listening') return
    if (now() - lastWake < DEBOUNCE_MS) return // one "hey jarvis" often fires twice
    lastWake = now()
    onWake(keyword)
  })

  function start() {
    if (state === 'listening' || state === 'starting' || state === 'paused') return
    set('starting')
    audio.setWakeActive(true)
    send('wake:enable', true) // the window opens the microphone and reports 'wake:mic'
  }
  function stop() {
    if (state === 'off') return
    audio.setWakeActive(false)
    send('wake:enable', false)
    set('off')
  }
  function pause() {
    if (state !== 'listening') return
    set('paused')
    send('wake:pause', true)
  }
  function resume() {
    if (state !== 'paused') return
    send('wake:pause', false)
    set('listening')
  }
  /** the window says whether it got the microphone */
  function mic(ev) {
    if (state === 'off') return
    if (ev && ev.ok) set('listening')
    else {
      audio.setWakeActive(false)
      set('failed', String((ev && ev.error) || 'no microphone'))
    }
  }
  /** samples from the window */
  function pcm(samples) {
    if (state !== 'listening' || !(samples instanceof Float32Array) || samples.length === 0 || samples.length > 16000) return
    audio.feedWake(samples)
  }

  return {
    start,
    stop,
    pause,
    resume,
    mic,
    pcm,
    get state() {
      return state
    }
  }
}

module.exports = { create, DEBOUNCE_MS }
