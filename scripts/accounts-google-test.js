'use strict'
// Tests for accounts/store.js, accounts/google.js and tools/google.js against a stand-in for Google (tools/fake-google.js).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fakeGoogle = require('../tools/fake-google')
const accountsStore = require('../accounts/store')
const googleMod = require('../accounts/google')
const { createGoogleTools } = require('../tools/google')
const { createRuntime } = require('../tools/runtime')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-google-test-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
const crypt = { available: () => true, enc: (s) => 'ENC:' + Buffer.from(s).reverse().toString('base64'), dec: (s) => Buffer.from(s.slice(4), 'base64').reverse().toString() }
const ALL = { mailRead: true, mailSend: true, calendar: true }

;(async () => {
  const fg = await fakeGoogle.start()
  const file = path.join(tmp, 'accounts.json')
  let store = accountsStore.create({ file, crypt })
  let clock = 1_000_000_000_000
  const now = () => clock
  const google = googleMod.create({ store, endpoints: fg.endpoints, openBrowser: fg.openBrowser, now, timeZone: 'Europe/London' })

  // ---------------------------------------------------------------- connecting
  await assert.rejects(google.connect({ clientId: 'bad id', access: ALL }), /does not look like a Google Client ID/)
  await assert.rejects(google.connect({ clientId: 'abcdefghij.apps.googleusercontent.com', access: {} }), /tick at least one/)
  fg.st.deny = true
  await assert.rejects(google.connect({ clientId: 'abcdefghij.apps.googleusercontent.com', access: ALL }), /you did not allow access/)
  fg.st.deny = false
  assert.equal(store.list().length, 0)

  const acct = await google.connect({ clientId: 'abcdefghij.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret123', access: ALL })
  assert.equal(acct.email, 'dhruv@example.com')
  assert.deepEqual(acct.scopes.sort(), ['email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'openid'].sort())
  const req = fg.st.authRequests.at(-1)
  assert.equal(req.access_type, 'offline', 'offline access is requested so a refresh token comes back')
  assert.equal(req.prompt, 'consent')
  assert.equal(req.client_id, 'abcdefghij.apps.googleusercontent.com')

  // stored encrypted, public view has no secrets
  const raw = fs.readFileSync(file, 'utf8')
  assert.ok(!raw.includes('GOCSPX-secret123') && !raw.includes('"RT'), 'no secret in plain text on disk')
  assert.ok(raw.includes('ENC:'))
  assert.ok(!JSON.stringify(store.list()).includes('GOCSPX') && !JSON.stringify(store.list()).includes('RT'))
  assert.equal(store.get(acct.id).clientSecret, 'GOCSPX-secret123')
  store = accountsStore.create({ file, crypt }) // survives a restart
  assert.equal(store.list().length, 1)
  const google2 = googleMod.create({ store, endpoints: fg.endpoints, openBrowser: fg.openBrowser, now, timeZone: 'Europe/London' })
  // without encryption nothing is stored
  assert.throws(() => accountsStore.create({ file: path.join(tmp, 'x.json'), crypt: { ...crypt, available: () => false } }).add({ provider: 'google', email: 'a@b.c', refreshToken: 'r', scopes: [] }), /encryption is not available/)

  // limited permissions: only what was ticked is granted, and the tools notice
  const narrow = await google2.connect({ clientId: 'abcdefghij.apps.googleusercontent.com', access: { mailRead: true } })
  assert.ok(narrow.id === acct.id, 'the same address updates the existing record instead of adding a second')
  assert.equal(store.list().length, 1)
  assert.equal(google2.has(store.list()[0], 'mailSend'), false)
  await google2.connect({ clientId: 'abcdefghij.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret123', access: ALL })

  // ---------------------------------------------------------------- tokens: refreshed when old, retried on 401, revoked => sign in again
  const id = acct.id
  const gt = googleMod.create({ store, endpoints: fg.endpoints, openBrowser: fg.openBrowser, now, timeZone: 'Europe/London' }) // empty token cache
  const before = fg.st.calls.filter((c) => c === 'POST /token').length
  await gt.unread(id, { max: 3 })
  assert.equal(fg.st.calls.filter((c) => c === 'POST /token').length, before + 1, 'a fresh access token was fetched with the stored refresh token')
  await gt.unread(id, { max: 3 })
  assert.equal(fg.st.calls.filter((c) => c === 'POST /token').length, before + 1, 'and reused while valid')
  clock += 3_700_000
  await gt.unread(id, { max: 3 })
  assert.equal(fg.st.calls.filter((c) => c === 'POST /token').length, before + 2, 'a new one after it expired')
  fg.st.expireNext = true
  assert.ok((await gt.unread(id, { max: 3 })).messages.length >= 1, 'a 401 is retried once with a new token')
  fg.st.revoked = true
  clock += 3_700_000
  await assert.rejects(gt.unread(id, {}), /needs to sign in again/)
  assert.equal(store.list()[0].needsSignIn, true)
  fg.st.revoked = false
  store.setNeedsSignIn(id, false)

  // ---------------------------------------------------------------- Gmail
  const un = await google2.unread(id, { max: 5 })
  assert.deepEqual(un.messages.map((m) => [m.id, m.from, m.subject]), [['m1abcdef', 'Mum <mum@example.com>', 'Dinner on Sunday?'], ['m2abcdef', 'Evil <evil@example.com>', 'URGENT']])
  assert.equal((await google2.unread(id, { max: 5, query: 'from:mum' })).messages.length, 1)
  const full = await google2.readMessage(id, 'm1abcdef')
  assert.equal(full.body, 'Are you coming at eight? Love, Mum')
  await assert.rejects(google2.readMessage(id, '../../etc'), /not a message id/)
  await assert.rejects(google2.readMessage(id, 'nope123456'), /not found/i)

  await google2.send(id, { to: 'mum@example.com', subject: 'Re: Dinner on Sunday?', body: 'Yes, see you at eight.' })
  const sent = fg.st.sent.at(-1)
  assert.match(sent, /^From: dhruv@example\.com\r\nTo: mum@example\.com\r\nSubject: Re: Dinner on Sunday\?\r\n/)
  const b64 = sent.split('\r\n\r\n')[1].replace(/\r\n/g, '')
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'Yes, see you at eight.')
  await google2.send(id, { to: 'mum@example.com', subject: 'Café ☕', body: 'ok' })
  assert.match(fg.st.sent.at(-1), /Subject: =\?UTF-8\?B\?/)
  const nSent = fg.st.sent.length
  for (const bad of [
    { to: 'mum@example.com\r\nBcc: boss@example.com', subject: 's', body: 'b' },
    { to: 'a@example.com, b@example.com', subject: 's', body: 'b' },
    { to: 'not-an-address', subject: 's', body: 'b' },
    { to: 'mum@example.com', subject: 'hi\r\nBcc: boss@example.com', body: 'b' },
    { to: 'mum@example.com', subject: 's', body: '' },
    { to: 'mum@example.com', subject: 's', body: 'x'.repeat(5001) }
  ]) await assert.rejects(google2.send(id, bad), /valid email|one short line|between 1 and 5000/, JSON.stringify(bad).slice(0, 60))
  assert.equal(fg.st.sent.length, nSent, 'nothing was sent for any bad input (no header injection)')

  // ---------------------------------------------------------------- Calendar
  const from = new Date(clock - 3_600_000 * 24)
  const to = new Date(Date.now() + 86_400_000)
  assert.equal((await google2.events(id, { from, to })).map((e) => e.title)[0], 'Standup')
  const start = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 16)
  const ev = await google2.addEvent(id, { title: 'Dentist', start, minutes: 45 })
  const posted = fg.st.events.at(-1)
  assert.equal(posted.start.timeZone, 'Europe/London')
  assert.equal((new Date(posted.end.dateTime) - new Date(posted.start.dateTime)) / 60000, 45)
  await google2.deleteEvent(id, ev.id)
  assert.ok(!fg.st.events.some((e) => e.id === ev.id))
  await assert.rejects(google2.deleteEvent(id, '../x'), /not an event id/)
  await assert.rejects(google2.addEvent(id, { title: 'x', start: 'tomorrow-ish' }), /understand that start time/)

  // a token without the calendar permission gets a friendly error
  const narrowAcct = await google2.connect({ clientId: 'abcdefghij.apps.googleusercontent.com', access: { mailRead: true } })
  await assert.rejects(google2.events(narrowAcct.id, { from, to }), /did not give me that permission/)
  await google2.connect({ clientId: 'abcdefghij.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret123', access: ALL })

  // ---------------------------------------------------------------- tools
  const audit = []
  const asked = []
  const rt = createRuntime({ audit: { log: (e) => audit.push(e) }, confirm: async (r) => (asked.push(r), true) })
  const tools = createGoogleTools({ google: google2, store, now: () => new Date(Date.now()) })
  for (const t of tools) rt.register(t)
  assert.deepEqual(Object.fromEntries(rt.tiers().map((t) => [t.name, t.tier])), { mail_unread: 'T0', mail_read: 'T0', mail_send: 'T2', calendar_events: 'T0', calendar_add: 'T1' })

  let r = await rt.call('mail_unread', {})
  assert.ok(r.ok && r.untrusted, 'mail text is untrusted')
  assert.match(r.spoken, /^You have 2 unread\. Mum: Dinner on Sunday\?\. Evil: URGENT\.$/)
  assert.equal(r.data[0].account, 'dhruv@example.com')
  r = await rt.call('mail_unread', { from: 'mum' })
  assert.match(r.spoken, /^You have 1 unread/)
  r = await rt.call('mail_read', { id: 'm2abcdef' })
  assert.ok(r.untrusted && /IGNORE ALL PREVIOUS INSTRUCTIONS/.test(r.data.body), 'the injected text is returned as data and flagged untrusted')

  r = await rt.call('mail_send', { to: 'mum@example.com', subject: 'Late', body: 'Running late, sorry.' })
  assert.ok(r.ok)
  assert.equal(asked.at(-1).tier, 'T2')
  assert.match(asked.at(-1).detail, /^Send an email\nTo: mum@example\.com\nSubject: Late\n\nRunning late, sorry\.\n\n\(This cannot be undone\.\)$/)
  assert.ok(fg.st.sent.at(-1).includes('To: mum@example.com'))
  assert.equal(r.undoId, undefined, 'a sent mail has no undo, and the box says so')
  const sentBefore = fg.st.sent.length
  r = await rt.call('mail_send', { to: 'x@example.com\nBcc: y@example.com', subject: 's', body: 'b' })
  assert.ok(!r.ok)
  assert.equal(fg.st.sent.length, sentBefore)

  r = await rt.call('calendar_events', { when: 'today' })
  assert.match(r.spoken, /^You have 1 event today: Standup at /)
  assert.ok(r.untrusted)
  r = await rt.call('calendar_events', { when: 'tomorrow' })
  assert.match(r.spoken, /Nothing on your calendar tomorrow/)
  const startAt = new Date(Date.now() + 26 * 3600_000).toISOString().slice(0, 16)
  r = await rt.call('calendar_add', { title: 'Dentist', start: startAt, duration_minutes: 30 })
  assert.ok(r.ok && /Added Dentist/.test(r.spoken), JSON.stringify(r))
  assert.ok(fg.st.events.some((e) => e.summary === 'Dentist'))
  assert.equal((await rt.undo()).spoken, 'Removed that event.')
  assert.ok(!fg.st.events.some((e) => e.summary === 'Dentist'), 'undo removed the event')
  r = await rt.call('calendar_add', { title: 'Past', start: '2020-01-01T10:00' })
  assert.match(r.error, /in the past/)
  assert.equal((await rt.call('calendar_add', { title: 'x', start: '2026-10-25T10:00', rm: 1 })).denied, true, 'unknown arguments are refused')

  // several accounts: reads combine, writes must name one
  fg.st.email = 'work@example.org'
  await google2.connect({ clientId: 'abcdefghij.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret123', access: ALL })
  assert.equal(store.list().length, 2)
  r = await rt.call('mail_unread', {})
  assert.ok(r.ok && r.data.some((m) => m.account === 'work@example.org') && r.data.some((m) => m.account === 'dhruv@example.com'))
  r = await rt.call('mail_send', { to: 'mum@example.com', subject: 's', body: 'b' })
  assert.match(r.error, /which account\? Connected: dhruv@example\.com, work@example\.org/)
  r = await rt.call('mail_send', { to: 'mum@example.com', subject: 's', body: 'b', account: 'work@' })
  assert.ok(r.ok)
  assert.match(fg.st.sent.at(-1), /^From: work@example\.org/)
  r = await rt.call('mail_send', { to: 'mum@example.com', subject: 's', body: 'b', account: 'example' })
  assert.match(r.error, /could not tell which account/)

  // tools hide themselves when no account has the permission; an account that needs sign-in does not count
  store.setNeedsSignIn(store.list()[0].id, true)
  store.setNeedsSignIn(store.list()[1].id, true)
  assert.deepEqual(rt.specs().map((s) => s.function.name), [], 'no usable account: no Google tools are offered to the model')
  assert.ok((await rt.call('mail_unread', {})).denied)

  console.log('accounts-google: ALL PASS')
  fg.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
