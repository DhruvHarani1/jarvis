'use strict'
/* The Accounts window: connect, reconnect and remove Google accounts. Secrets never come back to this page. */
;(function () {
  const $ = (id) => document.getElementById(id)
  let busy = false

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

  const GRANTS = [
    ['gmail.readonly', 'read mail'],
    ['gmail.send', 'send mail'],
    ['calendar.events', 'calendar']
  ]
  const setMsg = (text, bad) => {
    $('addmsg').textContent = text || ''
    $('addmsg').className = bad ? 'err' : 'ok'
  }

  async function refresh() {
    const s = await window.acctApi.state()
    $('warn').hidden = s.canEncrypt
    if (!s.canEncrypt) $('warn').textContent = 'Windows encryption is not available for this user, so Jarvis will not store a sign-in.'
    $('count').textContent = s.accounts.length ? `(${s.accounts.length})` : ''
    $('none').hidden = s.accounts.length > 0
    $('list').replaceChildren(
      ...s.accounts.map((a) =>
        el(
          'div',
          { class: 'key' },
          el('div', { class: 'n' }, '@'),
          el('div', { class: 't' }, a.email, el('span', { class: 'chip ' + (a.needsSignIn ? 'bad' : 'ok') }, a.needsSignIn ? 'SIGN IN AGAIN' : 'CONNECTED'), el('br'), el('small', {}, 'Google · allowed: ' + (GRANTS.filter(([g]) => a.scopes.some((x) => x.endsWith(g))).map(([, t]) => t).join(', ') || 'nothing'))),
          el(
            'div',
            { class: 'b' },
            el('button', { onclick: () => act(() => window.acctApi.reconnect(a.id), 'Your browser is open: sign in there…') }, 'Reconnect'),
            el('button', { class: 'danger', onclick: () => confirm('Remove ' + a.email + '? Jarvis will lose access to it.') && act(() => window.acctApi.remove(a.id), 'Removing…') }, 'Remove')
          )
        )
      )
    )
  }

  async function act(fn, working) {
    if (busy) return
    busy = true
    setMsg(working)
    try {
      const r = await fn()
      setMsg(r && r.ok ? r.message || 'Done.' : (r && r.error) || 'Something went wrong.', !(r && r.ok))
    } catch (e) {
      setMsg(String((e && e.message) || e), true)
    }
    busy = false
    await refresh()
  }

  $('connect').addEventListener('click', () =>
    act(
      () => window.acctApi.addGoogle({ clientId: $('cid').value, clientSecret: $('csec').value, access: { mailRead: $('pRead').checked, mailSend: $('pSend').checked, calendar: $('pCal').checked } }).then((r) => {
        if (r && r.ok) $('csec').value = ''
        return r
      }),
      'Your browser is open: sign in there…'
    )
  )
  $('guide').addEventListener('click', () => window.acctApi.openGuide('google'))
  $('msguide').addEventListener('click', () => window.acctApi.openGuide('microsoft'))
  refresh()
})()
