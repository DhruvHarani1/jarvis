'use strict'
/*
 * The Voice Lab page: check the microphone, score every speech engine on your own voice, and find the wake-word setting that suits you.
 * Recordings stay in this page's memory; the speech test sends them to the engines on this PC (and to Groq only if that is switched on in
 * Settings → Voice), the wake test to the keyword spotter on this PC. Nothing is saved to disk.
 */
;(function () {
  if (typeof window === 'undefined' || !window.manageApi || !window.VoiceCore) return
  const $ = (id) => document.getElementById(id)
  const VC = window.VoiceCore
  const api = window.manageApi

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
      else e.setAttribute(k, v)
    }
    e.append(...kids.filter((x) => x !== null && x !== undefined))
    return e
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let busy = false

  /** records from the chosen microphone for up to maxMs (or until stop()); resolves 16 kHz samples */
  async function record(maxMs, onLevel) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: window.Core.micConstraints() })
    const ctx = new AudioContext()
    await ctx.audioWorklet.addModule('pcm-worklet.js')
    const node = new AudioWorkletNode(ctx, 'pcm-tap')
    ctx.createMediaStreamSource(stream).connect(node)
    const rs = VC.createResampler(ctx.sampleRate, VC.TARGET_RATE)
    const parts = []
    node.port.onmessage = (ev) => {
      const out = rs.push(ev.data)
      parts.push(out)
      if (onLevel) onLevel(VC.rms(out))
    }
    let stopNow = () => {}
    const done = new Promise((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        node.port.onmessage = null
        node.disconnect()
        stream.getTracks().forEach((t) => t.stop())
        ctx.close().catch(() => {})
        const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
        let o = 0
        for (const p of parts) {
          all.set(p, o)
          o += p.length
        }
        resolve(all)
      }
      stopNow = finish
      setTimeout(finish, maxMs)
    })
    return { done, stop: () => stopNow() }
  }

  const meter = (level) => {
    $('l-meter').textContent = '▮'.repeat(Math.min(40, Math.round(level * 160))) || '·'
  }

  // ---------------------------------------------------------------- 1. microphone check
  $('l-mic').addEventListener('click', async () => {
    if (busy) return
    busy = true
    $('l-mic').disabled = true
    const out = $('l-micout')
    out.replaceChildren()
    try {
      $('l-micmsg').textContent = 'Stay quiet for two seconds…'
      const quiet = await (await record(2000, meter)).done
      $('l-micmsg').textContent = 'Now say: "testing one two three, hey Jarvis" in your normal voice…'
      await sleep(300)
      const talk = await (await record(3500, meter)).done
      meter(0)
      $('l-micmsg').textContent = ''
      const r = VC.analyzeMic(quiet, talk)
      out.replaceChildren(...r.findings.map((f) => el('p', { class: 'finding ' + f.level }, (f.level === 'ok' ? '✓ ' : f.level === 'warn' ? '⚠ ' : '✗ ') + f.text)), el('p', { class: 'muted' }, `room ${(r.noise * 100).toFixed(1)}% · voice ${(r.talk * 100).toFixed(1)}% · loudest ${(r.peak * 100).toFixed(0)}%`))
    } catch (e) {
      $('l-micmsg').textContent = e && e.name === 'NotAllowedError' ? 'Windows blocked the microphone (Settings → Privacy → Microphone).' : 'No microphone could be opened.'
    }
    $('l-mic').disabled = false
    busy = false
  })

  // ---------------------------------------------------------------- 2. speech test
  const PHRASES = ['What is my CPU usage?', 'Open WhatsApp and send a message to Mum.', 'Set a timer for ten minutes.', "What is on my calendar tomorrow?", 'Play some relaxing music on Spotify.']
  const scores = {} // engine name -> [wer, ...]
  const rowsEl = $('l-phrases')
  function drawSummary() {
    const names = Object.keys(scores)
    if (!names.length) return
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
    const ranked = names.map((n) => [n, avg(scores[n]), scores[n].length]).sort((a, b) => a[1] - b[1])
    $('l-sum').replaceChildren(
      el('b', {}, 'Average word errors on your voice: '),
      ...ranked.flatMap(([n, w, c], i) => [el('span', { class: i === 0 ? 'best' : '' }, `${n} ${(w * 100).toFixed(0)}% (${c} phrase${c === 1 ? '' : 's'})`), i < ranked.length - 1 ? ' · ' : ''])
    )
  }
  PHRASES.forEach((text, i) => {
    const btn = el('button', {}, 'Record')
    const res = el('div', { class: 's' })
    let rec = null
    btn.addEventListener('click', async () => {
      if (rec) {
        rec.stop()
        return
      }
      if (busy) return
      busy = true
      btn.textContent = 'Stop'
      res.textContent = 'Say it now, press Stop when done…'
      let samples
      try {
        rec = await record(9000, meter)
        samples = await rec.done
      } catch {
        res.textContent = 'No microphone.'
      }
      rec = null
      meter(0)
      btn.textContent = 'Record again'
      if (samples) {
        res.textContent = 'Listening with each engine…'
        const rows = await api.labSpeech(VC.encodeWav(samples, VC.TARGET_RATE))
        if (!rows.length) res.textContent = 'No speech engine is ready (Settings → Voice → download the models).'
        else {
          res.replaceChildren(...rows.map((r) => {
            const w = VC.wer(text, r.text)
            ;(scores[r.name] ||= [])[i] = w
            scores[r.name] = scores[r.name].filter((x) => x !== undefined)
            return el('div', { class: w <= 0.1 ? 'okline' : w <= 0.35 ? 'midline' : 'badline' }, `${r.name}: “${r.text || r.error || 'nothing'}” · ${Math.round(w * 100)}% wrong · ${r.ms} ms`)
          }))
          drawSummary()
        }
      }
      busy = false
    })
    rowsEl.append(el('div', { class: 'card lab-row' }, el('div', {}, el('b', {}, `${i + 1}. `), `Say: “${text}”`), btn, res))
  })

  // ---------------------------------------------------------------- 3. wake word test
  const wake = { yes: { low: 0, normal: 0, high: 0, n: 0 }, talk: { low: 0, normal: 0, high: 0, n: 0 } }
  function drawWake() {
    const names = { low: 'Careful', normal: 'Balanced', high: 'Eager' }
    $('l-wakeres').replaceChildren(
      el('p', { class: 'muted' }, `${wake.yes.n} "Hey Jarvis" clips, ${wake.talk.n} ordinary-talk clips`),
      ...['low', 'normal', 'high'].map((k) => el('div', {}, `${names[k]}: woke on ${wake.yes[k]} of ${wake.yes.n} "Hey Jarvis" clips · falsely on ${wake.talk[k]} of ${wake.talk.n} talk clips`))
    )
    if (wake.yes.n >= 3 && wake.talk.n >= 1) {
      // most wake-ups without a false one; on a tie the more careful setting
      const ok = ['low', 'normal', 'high'].filter((k) => wake.talk[k] === 0)
      const best = (ok.length ? ok : ['low']).reduce((b, k) => (wake.yes[k] > wake.yes[b] ? k : b))
      $('l-wakeapply').hidden = false
      $('l-wakeapply').textContent = `Use "${names[best]}" for my voice`
      $('l-wakeapply').dataset.pick = best
    }
  }
  async function wakeClip(kind, ms, prompt) {
    if (busy) return
    busy = true
    $('l-wakemsg').textContent = prompt
    try {
      await sleep(400)
      const samples = await (await record(ms, meter)).done
      meter(0)
      $('l-wakemsg').textContent = 'Checking…'
      const r = await api.labWake(samples)
      if (!r || !r.ok) $('l-wakemsg').textContent = (r && r.error) || 'The wake word model is not installed (Settings → Voice).'
      else {
        const bucket = wake[kind]
        bucket.n++
        for (const k of ['low', 'normal', 'high']) if (r.hits[k] > 0) bucket[k]++
        $('l-wakemsg').textContent = ''
        drawWake()
      }
    } catch {
      $('l-wakemsg').textContent = 'No microphone.'
    }
    busy = false
  }
  $('l-wakeyes').addEventListener('click', () => wakeClip('yes', 3000, 'Say "Hey Jarvis" now…'))
  $('l-waketalk').addEventListener('click', () => wakeClip('talk', 8000, 'Talk normally for a few seconds (read something out loud, say names like "Davis" or "Travis")…'))
  $('l-wakeapply').addEventListener('click', () => {
    window.jarvis.patchSettings({ wakeSensitivity: $('l-wakeapply').dataset.pick })
    $('l-wakemsg').textContent = 'Saved.'
  })

  // the wake word must not fire for real while the lab listens
  document.addEventListener('settings-page', (e) => api.labBusy(e.detail === 'lab'))
})()
