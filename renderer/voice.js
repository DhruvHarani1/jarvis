'use strict'
/*
 * Talk to Jarvis: Ctrl+Alt+Space (or the mic button) opens the microphone, listens until you stop speaking,
 * turns the audio into text (Groq Whisper if you have a key, otherwise Windows offline) and hands it to Jarvis like a typed command.
 * The microphone is only open while the badge shows the blue "listening" ring; nothing is recorded in the background.
 */
;(function () {
  if (typeof window === 'undefined' || !window.Core || !window.VoiceCore) return
  const VC = window.VoiceCore
  const $ = (id) => document.getElementById(id)
  const btn = $('micbtn')

  let session = null // the active listening session
  let followUp = false // the next idle moment (after she finishes speaking) opens the mic again
  let followTimer = 0
  let busy = false // transcribing / answering

  // ---------------------------------------------------------------- earcons (short beeps, no assets)
  let beepCtx = null
  function beep(freqs, ms = 90, gain = 0.07) {
    try {
      beepCtx = beepCtx || new AudioContext()
      const t0 = beepCtx.currentTime
      freqs.forEach((f, i) => {
        const o = beepCtx.createOscillator()
        const g = beepCtx.createGain()
        o.type = 'sine'
        o.frequency.value = f
        g.gain.setValueAtTime(0.0001, t0 + (i * ms) / 1000)
        g.gain.exponentialRampToValueAtTime(gain, t0 + (i * ms) / 1000 + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + ((i + 1) * ms) / 1000)
        o.connect(g).connect(beepCtx.destination)
        o.start(t0 + (i * ms) / 1000)
        o.stop(t0 + ((i + 1) * ms) / 1000 + 0.02)
      })
    } catch {
      /* no audio output */
    }
  }

  const setState = (s) => {
    document.body.dataset.listening = s === 'listening' || s === 'heard' ? '1' : '0'
    document.body.dataset.voice = s
    if (btn) {
      btn.dataset.on = s === 'listening' || s === 'heard' ? '1' : '0'
      btn.title = s === 'idle' ? 'Talk to Jarvis (Ctrl+Alt+Space)' : 'Stop listening'
    }
  }

  // ---------------------------------------------------------------- audio pipeline, loaded ahead of time (the microphone itself stays closed)
  let actx = null
  let actxReady = null
  function audioCtx() {
    if (!actx || actx.state === 'closed') {
      actx = new AudioContext()
      actxReady = actx.audioWorklet.addModule('pcm-worklet.js')
      actxReady.catch(() => {
        actx = null
      })
    }
    return actx
  }
  setTimeout(() => {
    try {
      audioCtx()
      actx.suspend().catch(() => {})
    } catch {
      /* will be created on first use */
    }
  }, 3000)

  // ---------------------------------------------------------------- listening
  const diag = []
  async function start(opts = {}) {
    if (window.Core.test) diag.push({ at: Date.now(), start: opts.followUp ? 'followUp' : 'manual', session: !!session, busy })
    if (session || busy) return false
    clearTimeout(followTimer)
    followUp = false
    window.jarvis.voiceListening(true) // main silences Jarvis and warms his voice
    let stream
    const ctx = audioCtx() // already loaded in the background, or loading now in parallel with the microphone
    const ready = actxReady
    try {
      ;[stream] = await Promise.all([navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }), ready])
    } catch (err) {
      setState('idle')
      window.Core.say(
        err && err.name === 'NotAllowedError'
          ? 'I CAN’T USE THE MICROPHONE. OPEN WINDOWS SETTINGS → PRIVACY → MICROPHONE AND ALLOW DESKTOP APPS.'
          : 'I CAN’T FIND A MICROPHONE.',
        9000,
        false
      )
      return false
    }
    await ctx.resume()
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-tap')
    src.connect(node)
    const vad = VC.createVad({ noSpeechMs: opts.followUp ? 5000 : 7000 })
    const s = { stream, ctx, node, chunks: [], vad, followUp: !!opts.followUp, ended: false, rate: ctx.sampleRate }
    session = s
    setState('listening')
    beep([660, 880], 70)
    if (!opts.followUp) window.Core.say('LISTENING…', 20000, false, true)

    node.port.onmessage = (ev) => {
      if (s.ended) return
      const samples = ev.data
      s.chunks.push(samples)
      const level = VC.rms(samples)
      document.body.style.setProperty('--lvl', Math.min(1, level * 8).toFixed(2))
      for (const e of vad.feed(level, (samples.length / s.rate) * 1000)) {
        if (e === 'speech') setState('heard')
        else if (e === 'end' || e === 'timeout') finish(true)
        else if (e === 'nospeech') finish(false)
      }
    }
    return true
  }

  function stopCapture(s) {
    s.ended = true
    try {
      s.node.port.onmessage = null
      s.node.disconnect()
    } catch {
      /* closed */
    }
    s.stream.getTracks().forEach((t) => t.stop())
    s.ctx.suspend().catch(() => {}) // kept for next time
    document.body.style.removeProperty('--lvl')
  }

  async function finish(hadSpeech) {
    const s = session
    if (!s || s.ended) return
    stopCapture(s)
    session = null
    window.jarvis.voiceListening(false)
    if (!hadSpeech && !s.vad.spoke) {
      setState('idle')
      beep([440], 90, 0.04)
      if (!s.followUp) window.Core.say('I DIDN’T HEAR ANYTHING. PRESS CTRL+ALT+SPACE AND TRY AGAIN.', 6000, false)
      else window.Core.say('', 1, false, true)
      return
    }
    // join, resample to 16 kHz, make a WAV
    const total = s.chunks.reduce((n, c) => n + c.length, 0)
    const all = new Float32Array(total)
    let o = 0
    for (const c of s.chunks) {
      all.set(c, o)
      o += c.length
    }
    const wav = VC.encodeWav(VC.resample(all, s.rate, VC.TARGET_RATE), VC.TARGET_RATE)
    if (wav.length < 44 + 0.35 * 32000) {
      setState('idle')
      return
    }
    if (window.Core.test) {
      let bin = ''
      for (let i = 0; i < wav.length; i += 8192) bin += String.fromCharCode.apply(null, wav.subarray(i, i + 8192))
      diag.push({ at: Date.now(), wavBytes: wav.length, lastWavB64: btoa(bin) })
    }
    busy = true
    setState('thinking')
    beep([880, 660], 70)
    window.Core.say('…', 30000, false, true)
    let res
    try {
      res = await window.jarvis.transcribe(wav.buffer)
    } catch {
      res = null
    }
    const text = res && res.ok ? String(res.text || '').trim() : ''
    if (!text) {
      busy = false
      setState('idle')
      if (!s.followUp) window.Core.say(res && res.ok ? 'I HEARD SOUND BUT NO WORDS. COULD YOU SAY THAT AGAIN?' : 'I COULDN’T MAKE THAT OUT: ' + String((res && res.error) || 'SPEECH RECOGNITION FAILED').toUpperCase(), 7000, false)
      return
    }
    if (window.Core.test) diag.push({ heard: text, via: res.via })
    window.Core.say('YOU: ' + text.toUpperCase(), 4000, false, true)
    setState('idle')
    try {
      await window.Assistant.handle(text, { voice: true, via: res.via })
    } finally {
      busy = false
    }
    // conversation mode: when she has finished speaking, listen again
    const info = await window.jarvis.voiceInfo().catch(() => null)
    if (info && info.converse) {
      followUp = true
      clearTimeout(followTimer)
      followTimer = setTimeout(() => (followUp = false), 30000)
    }
  }

  function toggle() {
    if (session) return finish(true) // pressed again: that's all I wanted to say
    if (busy) return
    start()
  }

  function cancel() {
    if (session) {
      const s = session
      stopCapture(s)
      session = null
      window.jarvis.voiceListening(false)
      setState('idle')
    }
  }

  window.jarvis.onVoiceToggle(toggle)
  // the wake word could not start (no microphone, privacy setting…): say why, once
  window.jarvis.onWakeState((s) => {
    document.body.dataset.wakeState = s.state
    if (s.state === 'failed') window.Core.say('I COULDN’T START THE WAKE WORD: ' + String(s.detail || 'THE RECOGNISER STOPPED').toUpperCase() + '. CHECK THE MICROPHONE PRIVACY SETTING.', 12000, false)
  })
  window.jarvis.onSpeechIdle(() => {
    if (followUp && !session && !busy) {
      followUp = false
      start({ followUp: true })
    }
  })
  if (btn) btn.addEventListener('click', toggle)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel()
  })
  setState('idle')

  window.Voice = { toggle, start, cancel, get listening() { return !!session } }
  if (window.Core.test) window.__voice = { diag, toggle, start, cancel, get session() { return session }, get busy() { return busy } }
})()
