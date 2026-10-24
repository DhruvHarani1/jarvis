'use strict'
/* First-run setup window: shows what is ready and starts the same actions as the tray menu. */
;(function () {
  const $ = (id) => document.getElementById(id)
  let busy = false

  const chip = (ok, text) => (ok ? '✓ ' + text : text)

  async function refresh() {
    const s = await window.welcomeApi.state()
    const have = [s.models.stt, s.models.voice, s.models.wake].filter(Boolean).length
    $('modelstate').textContent = have === 3 ? '✓ ready' : have ? `(${have} of 3 installed)` : ''
    $('models').hidden = have === 3
    $('wake').disabled = !s.models.wake
    $('wake').checked = s.wakeWord
    $('brainstate').textContent = s.keys ? chip(true, `${s.keys} key${s.keys === 1 ? '' : 's'} added`) : ''
    $('acctstate').textContent = s.accounts ? chip(true, `${s.accounts} connected`) : ''
  }

  $('mic').addEventListener('click', async () => {
    const msg = $('micmsg')
    msg.className = ''
    msg.textContent = 'Asking Windows…'
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      msg.className = 'err'
      msg.textContent = e && e.name === 'NotAllowedError' ? 'Windows blocked it. Open Settings → Privacy → Microphone and allow desktop apps.' : 'No microphone found.'
      return
    }
    const ctx = new AudioContext()
    const an = ctx.createAnalyser()
    ctx.createMediaStreamSource(stream).connect(an)
    const buf = new Uint8Array(an.fftSize)
    let peak = 0
    msg.textContent = 'Say something for three seconds…'
    const t0 = Date.now()
    await new Promise((resolve) => {
      const tick = () => {
        an.getByteTimeDomainData(buf)
        let m = 0
        for (const v of buf) m = Math.max(m, Math.abs(v - 128))
        peak = Math.max(peak, m)
        $('meter').textContent = '▮'.repeat(Math.min(30, Math.round(m / 3))) || '·'
        if (Date.now() - t0 < 3000) requestAnimationFrame(tick)
        else resolve()
      }
      tick()
    })
    stream.getTracks().forEach((t) => t.stop())
    ctx.close().catch(() => {})
    $('meter').textContent = ''
    $('micstate').textContent = peak > 10 ? '✓ works' : ''
    msg.className = peak > 10 ? 'ok' : 'err'
    msg.textContent = peak > 10 ? 'I can hear you.' : 'The microphone is open but I heard nothing. Check that the right microphone is selected in Windows sound settings.'
  })

  $('models').addEventListener('click', async () => {
    if (busy) return
    busy = true
    $('modelmsg').className = ''
    $('modelmsg').textContent = 'Check the box that opened…'
    const r = await window.welcomeApi.installModels(['stt', 'voice', 'wake'])
    $('modelmsg').className = r && r.ok ? 'ok' : 'err'
    $('modelmsg').textContent = r && r.message ? r.message : ''
    busy = false
    await refresh()
  })
  $('wake').addEventListener('change', async () => {
    await window.welcomeApi.setWake($('wake').checked)
    await refresh()
  })
  $('finish').addEventListener('click', () => window.welcomeApi.finish())
  document.addEventListener('settings-page', (e) => e.detail === 'setup' && refresh())
})()
