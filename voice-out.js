'use strict'
/**
 * Jarvis's voice. Same interface as speech.js (the Windows SAPI voice), so main.js does not care which one talks.
 *
 *   neural voice  : the audio worker turns each sentence into PCM (Piper), the window plays it. Used when the voice model
 *                   is installed and has not just failed.
 *   Windows voice : speech.js, the zero-download fallback. Also used for one sentence whenever the neural voice errors.
 *
 * Sentences are made one ahead of the one being played, so there is no gap between them.
 */
/** what is worth saying: no markdown marks, links, emoji or stray symbols; case is kept (it carries the intonation) */
function tidy(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>~|^]+/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const MAX_QUEUE = 8
const FAIL_PAUSE_MS = 60_000

/**
 * @param {{speech:any, audio:any, send:(channel:string, payload?:any)=>void, ready:()=>boolean, enabled?:()=>boolean, now?:()=>number}} o
 */
function create({ speech, audio, send, ready, enabled = () => true, now = Date.now }) {
  let queue = [] // { text, tag }
  let gen = 0 // bumped by stop(): results of older synths are thrown away
  let workingGen = -1 // generation the running pump belongs to
  let playing = null // id of the chunk the window is playing
  let nextId = 1
  let inflight = 0 // chunks sent to the window and not yet reported finished
  let failedAt = -Infinity
  let onStart = () => {}
  let onIdle = () => {}
  let onBusy = () => {}
  let busy = false
  const tags = new Map() // chunk id -> tag

  const neural = () => enabled() && ready() && now() - failedAt > FAIL_PAUSE_MS && !(process.env.SPIDEY_TEST && process.env.SPIDEY_SPEECH_LOG)

  function setBusy(b) {
    if (b === busy) return
    busy = b
    onBusy(b)
  }

  async function pump() {
    if (workingGen === gen) return
    workingGen = gen
    const myGen = gen
    try {
      while (queue.length && myGen === gen) {
        const item = queue.shift()
        const text = tidy(item.text)
        if (!text) continue
        let r
        try {
          r = await audio.speak(text)
        } catch (e) {
          if (process.env.JARVIS_DEBUG) console.log('[voice-out] neural voice failed:', e && e.message)
          failedAt = now()
          if (myGen === gen) void speech.speak(text, { queue: true, tag: item.tag })
          continue
        }
        if (myGen !== gen) return
        if (!r.samples || !r.samples.length) continue
        const id = nextId++
        tags.set(id, item.tag)
        inflight++
        setBusy(true)
        if (process.env.JARVIS_DEBUG) console.log('[voice-out] play', id, r.samples.length, JSON.stringify(text.slice(0, 40)))
        send('tts:play', { id, samples: r.samples, rate: r.rate })
        // keep one chunk ahead: wait until at most one is waiting in the window
        while (inflight > 1 && myGen === gen) await new Promise((res) => setTimeout(res, 20))
      }
    } finally {
      if (workingGen === myGen) workingGen = -1
      if (queue.length && myGen === gen) void pump()
    }
  }

  function speak(text, opts = {}) {
    if (process.env.JARVIS_DEBUG) console.log('[voice-out] speak', JSON.stringify(String(text).slice(0, 50)), JSON.stringify(opts))
    if (!neural()) return speech.speak(text, opts)
    const item = { text: String(text || ''), tag: opts.tag }
    if (!opts.queue) stop()
    else if (opts.urgent) {
      queue.unshift(item)
      send('tts:stop')
      inflight = 0
      gen++
      tags.clear()
      void pump()
      return Promise.resolve()
    }
    queue.push(item)
    if (queue.length > MAX_QUEUE) queue.shift()
    void pump()
    return Promise.resolve()
  }

  function stop() {
    gen++
    queue = []
    inflight = 0
    playing = null
    tags.clear()
    send('tts:stop')
    speech.stop()
    setBusy(false)
  }

  /** the window reports what it is doing */
  function played(ev) {
    if (process.env.JARVIS_DEBUG) console.log('[voice-out] event', JSON.stringify(ev))
    if (!ev || typeof ev.id !== 'number') return
    if (ev.state === 'started') {
      playing = ev.id
      const tag = tags.get(ev.id)
      if (tag) onStart(tag) // same rule as the Windows voice: only tagged items announce themselves (a caption)
    } else if (ev.state === 'ended') {
      tags.delete(ev.id)
      inflight = Math.max(0, inflight - 1)
      if (playing === ev.id) playing = null
      if (inflight === 0 && !queue.length && workingGen !== gen) {
        setBusy(false)
        onIdle()
      }
    }
  }

  return {
    speak,
    stop,
    played,
    warm: () => (neural() ? void audio.status().catch(() => {}) : speech.warm()),
    clean: speech.clean,
    setOnStart: (cb) => {
      onStart = cb
      speech.setOnStart(cb)
    },
    setOnIdle: (cb) => {
      onIdle = cb
      speech.setOnIdle(cb)
    },
    setOnBusy: (cb) => {
      onBusy = cb
      speech.setOnBusy(cb)
    },
    setVoice: speech.setVoice,
    getVoice: speech.getVoice,
    listVoices: speech.listVoices,
    resolveVoice: speech.resolveVoice,
    get neural() {
      return neural()
    }
  }
}

module.exports = { create, tidy, MAX_QUEUE, FAIL_PAUSE_MS }
