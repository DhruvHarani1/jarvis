'use strict'
/* The "AI brain" settings window: add / order / test API keys. It never sees a saved key again, only a masked hint. */
;(function () {
  const $ = (id) => document.getElementById(id)
  let presets = {}
  let busy = false

  const STATUS = { ok: 'WORKING', cooling: 'COOLING', bad: 'KEY REJECTED', untested: 'NOT TESTED' }

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

  async function refresh() {
    const s = await window.brainApi.state()
    presets = s.presets
    if (!$('provider').options.length) {
      for (const [id, p] of Object.entries(presets)) $('provider').append(el('option', { value: id }, p.name))
      onProvider()
    }
    $('natural').checked = s.settings.naturalChat
    $('smart').checked = s.settings.smartOrder
    const warn = $('warn')
    warn.hidden = s.settings.canEncrypt
    if (!s.settings.canEncrypt) warn.textContent = 'Windows encryption is not available for this user, so keys cannot be stored safely. Jarvis will refuse to save them.'

    $('count').textContent = s.entries.length ? `(${s.entries.length}) — tried top to bottom` : ''
    $('nokeys').hidden = s.entries.length > 0
    const box = $('keys')
    box.replaceChildren(
      ...s.entries.map((e, i) => {
        const status = e.enabled ? e.status : 'off'
        const label = status === 'cooling' ? `COOLING ${e.cooldownS}s` : status === 'off' ? 'OFF' : STATUS[status]
        return el(
          'div',
          { class: `key${e.enabled ? '' : ' disabled'}` },
          el('div', { class: 'n' }, String(i + 1)),
          el('div', { class: 't' }, e.label, el('span', { class: `chip ${status}` }, label), el('br'), el('small', {}, `${e.providerName} · ${e.model || 'model: auto'} · key ${e.keyHint}`)),
          el('div', { class: 'b' },
            el('button', { onclick: () => act(() => window.brainApi.move(e.id, -1)), title: 'Try this key earlier', 'aria-label': 'Move up' }, '▲'),
            el('button', { onclick: () => act(() => window.brainApi.move(e.id, 1)), title: 'Try this key later', 'aria-label': 'Move down' }, '▼'),
            el('button', { onclick: () => testKey(e.id) }, 'Test'),
            el('button', { onclick: () => act(() => window.brainApi.update(e.id, { enabled: !e.enabled })) }, e.enabled ? 'Turn off' : 'Turn on'),
            el('button', { onclick: () => replaceKey(e.id), title: 'Paste a new key for this entry' }, 'New key'),
            el('button', { class: 'danger', onclick: () => confirm(`Delete "${e.label}"?`) && act(() => window.brainApi.remove(e.id)), title: 'Delete' }, '✕')
          ),
          el('div', { class: 's', id: `msg-${e.id}` }, usageLine(e) + (e.lastError ? `  ·  Last problem: ${e.lastError}` : '')),
          el('div', { class: 's' }, e.privacy && e.privacy.note ? `${e.privacy.level === 'trains' ? '⚠ ' : ''}Privacy: ${e.privacy.note}` : '')
        )
      })
    )
    $('ollama').textContent = s.ollama.available ? `Running — will use ${s.ollama.model}.` : 'Not found. (That is fine if your online keys work.)'
    $('chain').textContent = s.chain.length ? s.chain.join('  →  ') : 'Nothing asked yet.'
  }

  /** "today 12 of 1000 requests · first word 640 ms" */
  function usageLine(e) {
    const u = e.usage || {}
    const parts = []
    if (u.rpdLimit) parts.push(`today ${u.rpdUsed} of ${u.rpdLimit} requests`)
    else parts.push(`today ${u.rpdUsed || 0} requests`)
    if (e.avgFirstWordMs) parts.push(`first word ${e.avgFirstWordMs} ms`)
    return parts.join(' · ')
  }

  async function act(fn) {
    if (busy) return
    busy = true
    try {
      await fn()
    } finally {
      busy = false
      await refresh()
    }
  }

  async function testKey(id) {
    const m = $(`msg-${id}`)
    if (m) m.textContent = 'Testing…'
    const r = await window.brainApi.test(id)
    await refresh()
    const m2 = $(`msg-${id}`)
    if (m2) m2.textContent = r.ok ? `✓ Works (${r.model}, ${r.ms} ms)` : `✗ ${r.error}`
  }

  async function replaceKey(id) {
    const k = prompt('Paste the new API key:')
    if (!k) return
    const r = await window.brainApi.update(id, { key: k.trim() })
    await refresh()
    const m = $(`msg-${id}`)
    if (m) m.textContent = r && r.ok === false ? `✗ ${r.error}` : 'New key saved. Press Test.'
  }

  function onProvider() {
    const p = presets[$('provider').value]
    if (!p) return
    $('hint').textContent = p.hint + (p.models.length ? ` Default model: ${p.models[0]} (auto-detected from your key).` : '')
    $('urlRow').hidden = !(p.editableUrl || $('provider').value === 'custom')
    if (p.editableUrl && !$('baseUrl').value) $('baseUrl').value = p.baseUrl
    $('get').hidden = !p.signup
  }

  $('provider').addEventListener('change', onProvider)
  $('get').addEventListener('click', () => window.brainApi.openLink(presets[$('provider').value].signup))
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-url]')
    if (b) window.brainApi.openLink(b.dataset.url)
  })
  $('smart').addEventListener('change', () => act(() => window.brainApi.smart($('smart').checked)))
  $('natural').addEventListener('change', () => act(() => window.brainApi.natural($('natural').checked)))

  $('add').addEventListener('click', async () => {
    const msg = $('addmsg')
    msg.className = ''
    msg.textContent = 'Adding…'
    const r = await window.brainApi.add({ provider: $('provider').value, key: $('key').value.trim(), label: $('label').value, model: $('model').value, baseUrl: $('baseUrl').value })
    if (!r.ok) {
      msg.className = 'err'
      msg.textContent = r.error
      return
    }
    $('key').value = ''
    $('label').value = ''
    $('model').value = ''
    msg.className = 'ok'
    msg.textContent = 'Saved. Testing it…'
    await refresh()
    const t = await window.brainApi.test(r.id)
    msg.className = t.ok ? 'ok' : 'err'
    msg.textContent = t.ok ? `✓ Works (${t.model}).` : `Saved, but the test failed: ${t.error}`
    await refresh()
  })

  refresh()
  setInterval(() => !busy && refresh(), 5000)
})()
