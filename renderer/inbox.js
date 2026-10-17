'use strict'
/* Notification inbox: every Windows toast from every app lands here. Badge = unread count. */
;(function () {
  const KEY = 'jarvis.inbox'
  const MAX = 100
  const $ = (id) => document.getElementById(id)
  const panel = $('inbox')
  const list = $('iitems')
  const count = $('icount')

  let items = []
  try {
    items = JSON.parse(localStorage.getItem(KEY) || '[]').filter((e) => e && typeof e.title === 'string')
  } catch {
    items = []
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX)))
    } catch {
      /* ignore */
    }
  }
  const unread = () => items.filter((i) => i.isNew).length

  function paint() {
    const n = unread()
    count.hidden = n === 0
    count.textContent = n > 99 ? '99+' : String(n)
    window.Core.setUnread('inbox', n)
  }

  function render() {
    list.replaceChildren(
      ...(items.length
        ? items.slice(0, MAX).map((it) => {
            const li = document.createElement('li')
            if (it.isNew) li.className = 'new'
            const app = document.createElement('b')
            app.textContent = it.app.toUpperCase()
            const when = document.createElement('em')
            when.textContent = new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            const t = document.createElement('span')
            t.className = 't'
            t.textContent = it.title
            li.append(app, when, t)
            if (it.body) {
              const d = document.createElement('span')
              d.className = 'd'
              d.textContent = it.body
              li.append(d)
            }
            li.title = 'Click to dismiss'
            li.addEventListener('click', () => {
              items = items.filter((x) => x !== it)
              save()
              render()
              paint()
            })
            return li
          })
        : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'INBOX ZERO. SENSE IS QUIET.' })])
    )
  }

  function markRead() {
    let changed = false
    for (const i of items) if (i.isNew) ((i.isNew = false), (changed = true))
    if (changed) save()
  }

  function toggle(open) {
    const show = open ?? panel.hidden
    panel.hidden = !show
    if (show) {
      $('slog').hidden = true
      render()
      markRead()
      paint()
    }
  }

  function onItems(batch) {
    if (!Array.isArray(batch)) return
    const known = new Set(items.map((i) => `${i.appId}#${i.id}`))
    let added = 0
    const fresh = []
    for (const b of batch) {
      if (!b || typeof b.title !== 'string' || known.has(`${b.appId}#${b.id}`)) continue
      items.unshift({
        id: Number(b.id) || 0,
        app: String(b.app || 'Windows').slice(0, 40),
        appId: String(b.appId || '').slice(0, 120),
        title: b.title.slice(0, 120),
        body: String(b.body || '').slice(0, 300),
        at: Number(b.at) || Date.now(),
        isNew: panel.hidden && Date.now() - (Number(b.at) || Date.now()) < 600000
      })
      added++
      fresh.push(items[0])
    }
    if (!added) return
    if (window.Reader) window.Reader.onNew(fresh)
    items = items.slice(0, MAX)
    save()
    if (!panel.hidden) render()
    paint()
  }

  $('inboxbtn').addEventListener('click', () => toggle())
  $('iclose').addEventListener('click', () => toggle(false))
  $('iclear').addEventListener('click', () => {
    items = []
    save()
    render()
    paint()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggle(false)
  })

  window.Inbox = { items: () => items, unread: () => items.filter((x) => x.isNew) }
  window.jarvis.onInbox(onItems)
  paint()
  if (window.Core.test) window.__inbox = { onItems, toggle, get items() { return items } }
})()
