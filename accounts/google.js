'use strict'
/**
 * Google: sign-in, Gmail and Calendar over the official REST APIs with the user's OWN OAuth app (see docs/setup).
 * Access tokens live only in memory; the refresh token is in the encrypted account store. Every call goes straight to Google.
 */
const oauth = require('./oauth')

const SCOPES = {
  mailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  mailSend: 'https://www.googleapis.com/auth/gmail.send',
  calendar: 'https://www.googleapis.com/auth/calendar.events'
}
const DEFAULT_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendar: 'https://www.googleapis.com/calendar/v3'
}

const EMAIL_RE = /^[^\s@<>,;"'()\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/
const noCrlf = (s) => !/[\r\n\u0000]/.test(s)

function decodeB64url(s) {
  return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}
const encodeB64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** best plain-text body from a Gmail "full" message */
function bodyText(payload) {
  const parts = []
  const walk = (p) => {
    if (!p) return
    if (p.mimeType === 'text/plain' && p.body && p.body.data) parts.push({ plain: true, text: decodeB64url(p.body.data) })
    else if (p.mimeType === 'text/html' && p.body && p.body.data) parts.push({ plain: false, text: decodeB64url(p.body.data) })
    for (const c of p.parts || []) walk(c)
  }
  walk(payload)
  const plain = parts.find((p) => p.plain)
  const text = plain
    ? plain.text
    : (parts[0] ? parts[0].text : '')
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

const header = (msg, name) => ((msg.payload && msg.payload.headers) || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

/** @param {{store:any, fetch?:typeof fetch, now?:()=>number, endpoints?:Partial<typeof DEFAULT_ENDPOINTS>, openBrowser:(url:string)=>any, timeZone?:string}} deps */
function create({ store, fetch: doFetch = fetch, now = Date.now, endpoints = {}, openBrowser, timeZone }) {
  const E = { ...DEFAULT_ENDPOINTS, ...endpoints }
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
  const cache = new Map() // account id -> { token, exp }

  const cfgOf = (a) => ({ authUrl: E.auth, tokenUrl: E.token, clientId: a.clientId, clientSecret: a.clientSecret || undefined, scopes: [] })

  async function accessToken(id) {
    const hit = cache.get(id)
    if (hit && hit.exp - now() > 60_000) return hit.token
    const a = store.get(id)
    if (!a) throw new Error('that account is not connected')
    try {
      const t = await oauth.refresh(cfgOf(a), a.refreshToken, { fetch: doFetch, now })
      cache.set(id, { token: t.access_token, exp: t.expires_at })
      return t.access_token
    } catch (e) {
      if (e.code === 'invalid_grant') {
        store.setNeedsSignIn(id, true)
        throw new Error(`Google says ${a.email} needs to sign in again (it was revoked, or the app is still in Testing mode and a week has passed). Open Accounts and connect it again.`)
      }
      throw e
    }
  }

  async function api(id, url, init = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(id)
      const res = await doFetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
      if (res.status === 401 && attempt === 0) {
        cache.delete(id)
        continue
      }
      if (res.status === 204) return null
      let j = null
      try {
        j = await res.json()
      } catch {
        /* no body */
      }
      if (!res.ok) {
        const msg = (j && j.error && (j.error.message || j.error.status)) || `HTTP ${res.status}`
        if (res.status === 403 && /insufficient|scope/i.test(msg)) throw new Error('Google did not give me that permission when you connected. Connect the account again and tick it.')
        if (res.status === 429) throw new Error('Google says slow down; try again in a minute.')
        throw new Error(`Google: ${String(msg).slice(0, 160)}`)
      }
      return j
    }
    throw new Error('Google would not accept the sign-in')
  }

  /**
   * Sign in a Google account with the user's own client. access = { mailRead, mailSend, calendar } (booleans).
   * @returns the public account record
   */
  async function connect({ clientId, clientSecret, access }) {
    clientId = String(clientId || '').trim()
    clientSecret = String(clientSecret || '').trim()
    if (!/^[A-Za-z0-9._-]{10,200}$/.test(clientId)) throw new Error('that does not look like a Google Client ID (it ends in .apps.googleusercontent.com)')
    if (clientSecret && !/^[A-Za-z0-9._-]{6,200}$/.test(clientSecret)) throw new Error('that does not look like a client secret')
    const scopes = ['openid', 'email', ...Object.entries(SCOPES).filter(([k]) => access && access[k]).map(([, v]) => v)]
    if (scopes.length === 2) throw new Error('tick at least one thing Jarvis may do')
    const t = await oauth.signIn(
      { authUrl: E.auth, tokenUrl: E.token, clientId, clientSecret: clientSecret || undefined, scopes, extraAuthParams: { access_type: 'offline', prompt: 'consent' } },
      { openBrowser, fetch: doFetch, now }
    )
    const granted = t.scope.split(/\s+/).filter(Boolean)
    const res = await doFetch(E.userinfo, { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15_000) })
    const info = await res.json().catch(() => ({}))
    if (!res.ok || !info.email) throw new Error('signed in, but Google would not tell me which account this is')
    const acct = store.add({ provider: 'google', email: info.email, clientId, clientSecret, refreshToken: t.refresh_token, scopes: granted })
    cache.set(acct.id, { token: t.access_token, exp: t.expires_at })
    return acct
  }

  const has = (a, key) => a.scopes.includes(SCOPES[key])

  // ------------------------------------------------------------------ Gmail
  async function unread(id, { max = 5, query = '' } = {}) {
    const n = Math.max(1, Math.min(10, max))
    const q = new URLSearchParams({ q: `is:unread in:inbox ${query}`.trim(), maxResults: String(n) })
    const list = await api(id, `${E.gmail}/messages?${q}`)
    const ids = ((list && list.messages) || []).map((m) => m.id)
    const msgs = []
    for (const mid of ids) {
      const m = await api(id, `${E.gmail}/messages/${encodeURIComponent(mid)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
      msgs.push({ id: m.id, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: String(m.snippet || '').slice(0, 160) })
    }
    return { total: (list && list.resultSizeEstimate) || msgs.length, messages: msgs }
  }

  async function readMessage(id, mid) {
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(mid)) throw new Error('that is not a message id')
    const m = await api(id, `${E.gmail}/messages/${encodeURIComponent(mid)}?format=full`)
    return { id: m.id, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'), body: bodyText(m.payload).slice(0, 3000) }
  }

  async function send(id, { to, subject, body }) {
    if (!EMAIL_RE.test(String(to || '')) || !noCrlf(to)) throw new Error('that is not a single valid email address')
    if (!noCrlf(String(subject || '')) || String(subject).length > 200) throw new Error('the subject must be one short line')
    if (!body || String(body).length > 5000) throw new Error('the message must be between 1 and 5000 characters')
    const a = store.get(id)
    const subj = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
    const mime = [`From: ${a.email}`, `To: ${to}`, `Subject: ${subj}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(String(body), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')].join('\r\n')
    const r = await api(id, `${E.gmail}/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: encodeB64url(mime) }) })
    return { id: r && r.id }
  }

  // ------------------------------------------------------------------ Calendar
  const JOIN = /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|(?:[a-z0-9-]+\.)?zoom\.us)\/[^\s<>"')]+/i
  /** the link that joins an online meeting: Google Meet, or a Teams / Zoom link in the place or description */
  const joinLink = (e) => {
    if (e.hangoutLink && JOIN.test(e.hangoutLink)) return e.hangoutLink
    const video = ((e.conferenceData && e.conferenceData.entryPoints) || []).find((p) => p.entryPointType === 'video' && JOIN.test(p.uri || ''))
    if (video) return video.uri
    const m = JOIN.exec(`${e.location || ''} ${e.description || ''}`)
    return m ? m[0].replace(/[.,;]+$/, '') : ''
  }
  const mapEvent = (e) => {
    const allDay = !!(e.start && e.start.date)
    return { join: joinLink(e), id: e.id, title: e.summary || '(no title)', start: (e.start && (e.start.dateTime || e.start.date)) || '', end: (e.end && (e.end.dateTime || e.end.date)) || '', allDay, location: e.location || '', status: e.status }
  }

  async function events(id, { from, to, max = 15 }) {
    const q = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(30, max)) })
    const r = await api(id, `${E.calendar}/calendars/primary/events?${q}`)
    return ((r && r.items) || []).filter((e) => e.status !== 'cancelled').map(mapEvent)
  }

  async function addEvent(id, { title, start, minutes = 60, description }) {
    const s = new Date(start)
    if (!Number.isFinite(s.getTime())) throw new Error('I could not understand that start time')
    const e = new Date(s.getTime() + minutes * 60_000)
    const body = { summary: String(title).slice(0, 200), start: { dateTime: s.toISOString(), timeZone: tz }, end: { dateTime: e.toISOString(), timeZone: tz } }
    if (description) body.description = String(description).slice(0, 2000)
    const r = await api(id, `${E.calendar}/calendars/primary/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return mapEvent(r)
  }

  async function deleteEvent(id, eventId) {
    if (!/^[A-Za-z0-9_-]{4,200}$/.test(eventId)) throw new Error('that is not an event id')
    await api(id, `${E.calendar}/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' })
  }

  return { connect, has, unread, readMessage, send, events, addEvent, deleteEvent, accessToken, SCOPES }
}

module.exports = { create, SCOPES, DEFAULT_ENDPOINTS, bodyText, EMAIL_RE }
