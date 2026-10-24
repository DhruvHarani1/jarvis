'use strict'
/*
 * The settings of the one Jarvis window: a panel that slides over the orb with pages for General, Voice, AI brain, Accounts and Setup.
 * The AI brain, Accounts and Setup pages have their own scripts (brain.js, accounts.js, welcome.js); this file opens and closes the
 * panel, switches pages (telling those scripts through the "settings-page" event) and drives the General and Voice pages.
 */
;(function () {
  if (typeof window === 'undefined' || !window.jarvis) return
  const $ = (id) => document.getElementById(id)
  const panel = $('settings')
  const PAGES = ['general', 'voice', 'lab', 'brain', 'accounts', 'tools', 'memory', 'activity', 'setup']
  let current = ''

  function show(page) {
    if (!page || !PAGES.includes(page)) {
      current = ''
      panel.hidden = true
      document.body.dataset.settings = '0'
      if (panel.contains(document.activeElement)) $('input').focus()
      document.dispatchEvent(new CustomEvent('settings-page', { detail: '' }))
      return
    }
    const opening = panel.hidden
    current = page
    panel.hidden = false
    document.body.dataset.settings = '1'
    for (const p of PAGES) $('page-' + p).hidden = p !== page
    for (const b of panel.querySelectorAll('[data-go]')) b.setAttribute('aria-current', b.dataset.go === page ? 'page' : 'false')
    document.dispatchEvent(new CustomEvent('settings-page', { detail: page }))
    const cur = panel.querySelector('[data-go][aria-current="page"]')
    if (cur && opening) cur.focus() // keyboard users land in the panel
  }

  $('setbtn').addEventListener('click', () => (current ? show('') : show('general')))
  $('sclose').addEventListener('click', () => show(''))
  for (const b of panel.querySelectorAll('[data-go]')) b.addEventListener('click', () => show(b.dataset.go))
  window.jarvis.onSettingsPage((p) => show(p))
  document.addEventListener('settings-open', (e) => show(e.detail))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) show('')
  })
  // "Open the Accounts page" style buttons inside the pages
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]')
    if (b) show(b.dataset.open)
  })

  // ---- the conversation drawer
  const drawer = $('drawer')
  $('drawerbtn').addEventListener('click', () => {
    const open = drawer.dataset.expanded !== '1'
    drawer.dataset.expanded = open ? '1' : '0'
    $('drawerbtn').setAttribute('aria-expanded', String(open))
    $('dcaret').textContent = open ? '▾' : '▴'
  })

  // ---- General
  let cfg = {}
  const toggles = ['jarvisSpeaks', 'voiceConverse', 'readNotifications', 'morningBriefing']
  for (const k of toggles) $('s-' + k).addEventListener('change', (e) => window.jarvis.patchSettings({ [k]: e.target.checked }))
  $('s-save').addEventListener('click', () => {
    window.jarvis.patchSettings({ callMe: $('s-callMe').value })
    $('s-savemsg').textContent = 'Saved.'
    setTimeout(() => ($('s-savemsg').textContent = ''), 2000)
  })
  $('s-menu').addEventListener('click', () => window.jarvis.showMenu())

  // ---- Voice
  async function devices() {
    const sel = $('v-device')
    try {
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      sel.replaceChildren(new Option('Windows default', ''), ...all.map((d, i) => new Option(d.label || 'Microphone ' + (i + 1), d.deviceId)))
      sel.value = cfg.micDevice && all.some((d) => d.deviceId === cfg.micDevice) ? cfg.micDevice : ''
    } catch {
      sel.replaceChildren(new Option('Windows default', ''))
    }
  }
  $('v-device').addEventListener('change', (e) => window.jarvis.patchSettings({ micDevice: e.target.value }))
  for (const k of ['micEcho', 'micNoise', 'micAgc']) $('v-' + k).addEventListener('change', (e) => window.jarvis.patchSettings({ [k]: e.target.checked }))
  $('v-sttauto').addEventListener('change', () => window.jarvis.patchSettings({ sttMode: 'auto' }))
  $('v-sttoff').addEventListener('change', () => window.jarvis.patchSettings({ sttMode: 'offline' }))
  $('v-sens').addEventListener('change', (e) => window.jarvis.patchSettings({ wakeSensitivity: e.target.value }))
  $('v-light').addEventListener('change', (e) => window.jarvis.patchSettings({ sttLocal: e.target.checked ? 'light' : 'best' }))
  $('v-wakeWord').addEventListener('change', async (e) => {
    await window.welcomeApi.setWake(e.target.checked)
    await refreshVoice()
  })
  async function download(bundles, btn) {
    btn.disabled = true
    $('v-dlmsg').textContent = 'Check the box that opened…'
    const r = await window.welcomeApi.installModels(bundles)
    $('v-dlmsg').textContent = (r && r.message) || ''
    btn.disabled = false
    await refreshVoice()
  }
  $('v-dl').addEventListener('click', () => download(['stt', 'voice', 'wake'], $('v-dl')))
  $('v-dlp').addEventListener('click', () => download(['stt-parakeet'], $('v-dlp')))

  async function refreshVoice() {
    const s = await window.welcomeApi.state()
    if (!s) return
    const m = s.models
    $('v-wakeWord').disabled = !m.wake
    $('v-wakeWord').checked = !!s.wakeWord && !!m.wake
    $('v-wakehint').textContent = m.wake ? '' : 'Needs the wake word model: use "Download voice models" below.'
    $('v-dl').hidden = m.stt && m.voice && m.wake
    $('v-dlp').hidden = !!m.parakeet
    $('v-models').textContent = `On this PC: ${m.parakeet ? '✓ accurate model' : '✗ accurate model'}  ·  ${m.stt ? '✓ fast model' : '✗ fast model'}  ·  ${m.voice ? '✓ natural voice' : '✗ natural voice'}  ·  ${m.wake ? '✓ wake word' : '✗ wake word'}`
  }

  function apply(s) {
    cfg = { ...cfg, ...s }
    for (const k of toggles) $('s-' + k).checked = !!cfg[k]
    if (document.activeElement !== $('s-callMe')) $('s-callMe').value = cfg.callMe || ''
    for (const k of ['micEcho', 'micNoise', 'micAgc']) $('v-' + k).checked = !!cfg[k]
    $('v-sttauto').checked = cfg.sttMode !== 'offline'
    $('v-sttoff').checked = cfg.sttMode === 'offline'
    $('v-light').checked = cfg.sttLocal === 'light'
    $('v-sens').value = cfg.wakeSensitivity || 'normal'
  }
  window.jarvis.getSettings().then(apply)
  window.jarvis.onSettings(apply)
  document.addEventListener('settings-page', (e) => {
    if (e.detail === 'voice') {
      void refreshVoice()
      void devices()
    }
  })
})()
