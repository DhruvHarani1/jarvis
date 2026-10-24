'use strict'
/* The Tools, Memory and Activity pages of the settings. The risky switches (Power mode, screen understanding) only ask: the main process shows its own warning box and decides. */
;(function () {
  if (typeof window === 'undefined' || !window.manageApi) return
  const $ = (id) => document.getElementById(id)
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
  const say = (text) => {
    $('t-msg').textContent = text || ''
    setTimeout(() => ($('t-msg').textContent = ''), 4000)
  }

  // ---- tools
  function drawTools(s) {
    if (!s) return
    $('t-actions').checked = s.actions
    $('t-screen').checked = s.screenVision
    $('t-power').checked = s.powerMode
    $('t-list').replaceChildren(
      ...s.tools.map((t) => {
        const box = el('input', { type: 'checkbox' })
        box.checked = t.enabled
        box.addEventListener('change', async () => drawTools(await api.toolsSet('tool', { name: t.name, enabled: box.checked })))
        return el('label', { class: 'toggle' }, box, el('b', {}, t.name.replace(/_/g, ' ')), ' ', el('span', {}, `(${t.tier})`))
      })
    )
  }
  async function refreshTools() {
    drawTools(await api.toolsState())
  }
  $('t-actions').addEventListener('change', async (e) => drawTools(await api.toolsSet('actions', e.target.checked)))
  // the box the main process shows decides; the switch then shows what really happened
  $('t-screen').addEventListener('change', async (e) => drawTools(await api.toolsSet('screenVision', e.target.checked)))
  $('t-power').addEventListener('change', async (e) => drawTools(await api.toolsSet('powerMode', e.target.checked)))
  $('t-undo').addEventListener('click', async () => say((await api.undo()).message))
  $('t-brief').addEventListener('click', () => {
    api.briefingNow()
    say('Starting your briefing…')
  })

  // ---- memory
  async function refreshMemory() {
    const s = await api.memoryState()
    $('m-none').hidden = s.available
    $('m-count').textContent = s.facts.length ? `(${s.facts.length})` : ''
    $('m-facts').replaceChildren(
      ...(s.facts.length ? s.facts.map((f) => el('div', { class: 'key' }, el('div', { class: 'n' }, '•'), el('div', { class: 't' }, f.text, f.source === 'tainted' ? el('span', { class: 'chip bad' }, 'FROM A MESSAGE: NEVER USED') : null), el('div', { class: 'b' }, el('button', { class: 'danger', onclick: async () => (await api.memoryForget(f.id), refreshMemory()) }, 'Forget')))) : [el('p', { class: 'muted' }, 'Nothing yet.')])
    )
    $('m-contacts').replaceChildren(
      ...(s.contacts.length ? s.contacts.map((c) => el('div', { class: 'key' }, el('div', { class: 'n' }, '@'), el('div', { class: 't' }, c.name, el('br'), el('small', {}, [c.phone, c.email].filter(Boolean).join(' · ') || 'no number or address')), el('div', { class: 'b' }, el('button', { class: 'danger', onclick: async () => (await api.contactDelete(c.id), refreshMemory()) }, 'Remove')))) : [el('p', { class: 'muted' }, 'No contacts. Say "save Mum\'s number as …" to add one.')])
    )
  }
  $('m-export').addEventListener('click', () => api.memoryExport())
  $('m-forget').addEventListener('click', async () => (await api.memoryForgetAll(), refreshMemory()))

  // ---- activity
  async function refreshActivity() {
    const rows = await api.activity()
    $('a-list').replaceChildren(
      ...(rows.length
        ? rows.map((r) => {
            const when = String(r.t || '').replace('T', ' ').slice(0, 19)
            const what = r.tool || 'action'
            const result = r.error || (r.result && r.result.spoken) || r.decision || ''
            return el('div', { class: 'key' }, el('div', { class: 'n' }, r.ok === false ? '✗' : '✓'), el('div', { class: 't' }, String(what).replace(/_/g, ' '), r.tier ? el('span', { class: 'chip untested' }, r.tier) : null, el('br'), el('small', {}, `${when}${result ? ' · ' + String(result).slice(0, 120) : ''}`)))
          })
        : [el('p', { class: 'muted' }, 'Nothing yet.')])
    )
  }
  $('a-open').addEventListener('click', () => api.activityOpen())

  document.addEventListener('settings-page', (e) => {
    if (e.detail === 'tools') void refreshTools()
    if (e.detail === 'memory') void refreshMemory()
    if (e.detail === 'activity') void refreshActivity()
  })
})()
