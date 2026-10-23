'use strict'
/*
 * Microphone feed for the "Hey Jarvis" keyword spotter. Only runs while the wake word is switched on (the system's
 * microphone-in-use indicator is then on, and the badge shows the blue ear). Samples are resampled to 16 kHz and handed to the
 * main process, which passes them to the on-PC model; nothing is recorded or sent anywhere.
 */
;(function () {
  if (typeof window === 'undefined' || !window.jarvis || !window.jarvis.onWakeEnable || !window.VoiceCore) return
  const VC = window.VoiceCore
  let cap = null // { stream, ctx, node }
  let paused = false
  let starting = false

  async function open() {
    if (cap || starting) return
    starting = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      const ctx = new AudioContext()
      await ctx.audioWorklet.addModule('pcm-worklet.js')
      const src = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'pcm-tap')
      src.connect(node)
      node.port.onmessage = (ev) => {
        if (paused) return
        window.jarvis.wakePcm(VC.resample(ev.data, ctx.sampleRate, VC.TARGET_RATE))
      }
      cap = { stream, ctx, node }
      window.jarvis.wakeMic({ ok: true })
    } catch (err) {
      window.jarvis.wakeMic({ ok: false, error: err && err.name === 'NotAllowedError' ? 'microphone blocked in Windows privacy settings' : 'no microphone found' })
    } finally {
      starting = false
    }
  }

  function close() {
    if (!cap) return
    const c = cap
    cap = null
    try {
      c.node.port.onmessage = null
      c.node.disconnect()
    } catch {
      /* closed */
    }
    c.stream.getTracks().forEach((t) => t.stop())
    c.ctx.close().catch(() => {})
  }

  window.jarvis.onWakeEnable((on) => {
    paused = false
    if (on) void open()
    else close()
  })
  window.jarvis.onWakePause((p) => {
    paused = !!p
  })
})()
