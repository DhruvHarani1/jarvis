'use strict'
/*
 * Plays Jarvis's natural voice. The audio worker sends one sentence at a time as raw PCM; this schedules them back to back
 * and tells the main process when each one starts and ends (it uses that for "speaking" state, wake-word pausing and follow-ups).
 */
;(function () {
  if (typeof window === 'undefined' || !window.jarvis || !window.jarvis.onTtsPlay) return
  let ctx = null
  let nextStart = 0
  const live = new Set()

  function context() {
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext()
      nextStart = 0
    }
    return ctx
  }

  window.jarvis.onTtsPlay(async (m) => {
    if (!m || typeof m.id !== 'number' || !m.samples || !(m.rate > 8000 && m.rate < 96000)) return
    const c = context()
    if (c.state === 'suspended') await c.resume().catch(() => {})
    const samples = m.samples instanceof Float32Array ? m.samples : new Float32Array(m.samples)
    const buf = c.createBuffer(1, samples.length, m.rate)
    buf.copyToChannel(samples, 0)
    const src = c.createBufferSource()
    src.buffer = buf
    src.connect(c.destination)
    const at = Math.max(c.currentTime + 0.02, nextStart)
    nextStart = at + buf.duration
    live.add(src)
    src.onended = () => {
      live.delete(src)
      window.jarvis.ttsEvent({ id: m.id, state: 'ended' })
    }
    setTimeout(() => window.jarvis.ttsEvent({ id: m.id, state: 'started' }), Math.max(0, (at - c.currentTime) * 1000))
    src.start(at)
  })

  window.jarvis.onTtsStop(() => {
    for (const s of live) {
      s.onended = null
      try {
        s.stop()
      } catch {
        /* already finished */
      }
    }
    live.clear()
    nextStart = 0
  })
})()
