'use strict'
/**
 * "Smart" wake word: listens with a voice-activity detector and, whenever someone says something, writes it down with the speech
 * model on this PC and looks for "Jarvis" in the first words (see wake-match.js). If the sentence goes on after the name, the rest
 * is handed over as the command, so "Hey Jarvis, what is the time" needs no second step.
 *
 * Costs nothing while the room is quiet (no model work), a short transcription after each utterance otherwise. Audio is only held
 * in memory for the length of one utterance, never stored.
 */
const { wakeMatch } = require('./wake-match')

const RATE = 16000
const FRAME = 320 // 20 ms
const PRE_ROLL_FRAMES = 20 // 400 ms kept from before the speech started (the "he" of "hey")
const START_FRAMES = 3 // 60 ms of sound to call it speech
const END_SILENCE_FRAMES = 24 // 480 ms of quiet ends an utterance
const MIN_SPEECH_FRAMES = 14 // shorter than 280 ms is a click or a cough
const MAX_FRAMES = 450 // 9 s: cut very long talk (a TV, a call) and carry on
const MAX_QUEUE = 2

/**
 * @param {{transcribe:(samples:Float32Array)=>Promise<string>, onHeard?:(text:string, matched:boolean)=>void, onWake:(rest:string, text:string)=>void, onError?:(e:Error)=>void}} o
 */
function create({ transcribe, onHeard = () => {}, onWake, onError = () => {} }) {
  let pending = new Float32Array(0)
  const ring = [] // recent frames while idle
  let seg = null // { frames:Float32Array[], speech:number, quiet:number }
  let floor = 0.004 // the room's level, tracked slowly
  let loud = 0
  const queue = []
  let busy = false

  const rmsOf = (f) => {
    let s = 0
    for (let i = 0; i < f.length; i++) s += f[i] * f[i]
    return Math.sqrt(s / f.length)
  }

  async function pump() {
    if (busy) return
    busy = true
    while (queue.length) {
      const samples = queue.shift()
      try {
        const text = String((await transcribe(samples)) || '').trim()
        if (!text) continue
        const m = wakeMatch(text)
        onHeard(text, m.matched)
        if (m.matched) onWake(m.rest, text)
      } catch (e) {
        onError(e)
      }
    }
    busy = false
  }

  function finish() {
    const s = seg
    seg = null
    if (!s || s.speech < MIN_SPEECH_FRAMES) return
    const n = s.frames.reduce((a, f) => a + f.length, 0)
    const out = new Float32Array(n)
    let o = 0
    for (const f of s.frames) {
      out.set(f, o)
      o += f.length
    }
    queue.push(out)
    while (queue.length > MAX_QUEUE) queue.shift() // never fall behind: the newest speech matters most
    void pump()
  }

  function frame(f) {
    const level = rmsOf(f)
    const threshold = Math.max(0.006, floor * 2.6 + 0.003)
    const isLoud = level > threshold
    if (!isLoud) floor += (Math.min(level, 0.05) - floor) * 0.02 // learn the room from the quiet frames only
    if (!seg) {
      ring.push(f)
      if (ring.length > PRE_ROLL_FRAMES) ring.shift()
      loud = isLoud ? loud + 1 : 0
      if (loud >= START_FRAMES) {
        seg = { frames: [...ring], speech: loud, quiet: 0 }
        ring.length = 0
        loud = 0
      }
      return
    }
    seg.frames.push(f)
    if (isLoud) {
      seg.speech++
      seg.quiet = 0
    } else seg.quiet++
    if (seg.quiet >= END_SILENCE_FRAMES || seg.frames.length >= MAX_FRAMES) finish()
  }

  function feed(samples) {
    if (!(samples instanceof Float32Array) || !samples.length) return
    const all = new Float32Array(pending.length + samples.length)
    all.set(pending)
    all.set(samples, pending.length)
    let i = 0
    for (; i + FRAME <= all.length; i += FRAME) frame(all.subarray(i, i + FRAME))
    pending = all.slice(i)
  }

  function reset() {
    pending = new Float32Array(0)
    ring.length = 0
    seg = null
    loud = 0
    queue.length = 0
  }

  return { feed, reset, get busy() { return busy }, get floor() { return floor } }
}

module.exports = { create, RATE, FRAME }
