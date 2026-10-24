'use strict'
/**
 * Gmail and Google Calendar tools. They hide themselves until a Google account with the right permission is connected.
 * Mail and event text is written by other people, so every result that carries it is marked untrusted (the conversation
 * becomes "tainted" and risky actions then need a click). Sending always asks first and shows the whole message.
 */
const obj = (properties, required = []) => ({ type: 'object', properties, required })

const when = (w, now = new Date()) => {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const days = { today: [0, 1], tomorrow: [1, 2], next_7_days: [0, 7] }[w] || [0, 1]
  const from = w === 'today' ? now : new Date(start.getTime() + days[0] * 86_400_000)
  return { from, to: new Date(start.getTime() + days[1] * 86_400_000), label: w === 'next_7_days' ? 'in the next seven days' : w }
}

const timeOf = (e) => (e.allDay ? 'all day' : new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
const nameOf = (from) => (/^"?([^"<]+?)"?\s*</.exec(from) || [])[1] || String(from).replace(/<.*$/, '').trim() || 'someone'

/**
 * @param {{google:ReturnType<typeof import('../accounts/google').create>, store:any, now?:()=>Date}} d
 */
function createGoogleTools(d) {
  const now = d.now || (() => new Date())
  const accounts = (key) => d.store.list('google').filter((a) => !a.needsSignIn && (!key || d.google.has(a, key)))
  const anyWith = (key) => accounts(key).length > 0

  /** reads use every connected account; writes need one, named if there are several */
  function targets(account, key, { write = false } = {}) {
    const all = accounts(key)
    if (!all.length) throw new Error('no connected Google account has that permission; open Accounts to connect or reconnect one')
    if (account) {
      const hit = all.filter((a) => a.email.toLowerCase().includes(String(account).toLowerCase()))
      if (hit.length !== 1) throw new Error(`I could not tell which account you mean. Connected: ${all.map((a) => a.email).join(', ')}`)
      return hit
    }
    if (write && all.length > 1) throw new Error(`which account? Connected: ${all.map((a) => a.email).join(', ')}`)
    return all
  }
  const acctProp = { account: { type: 'string', maxLength: 80, description: 'Which connected Google account, by part of its email address. Optional when only one is connected.' } }
  const T = []

  T.push({
    name: 'mail_unread',
    tier: 'T0',
    description: 'List the newest unread emails in the inbox (sender, subject, a short preview) from the connected Google accounts.',
    enabled: () => anyWith('mailRead'),
    schema: obj({ max: { type: 'integer', minimum: 1, maximum: 10 }, from: { type: 'string', maxLength: 80, description: 'Only mail from this sender or address.' }, ...acctProp }),
    run: async ({ max = 5, from, account }) => {
      const found = []
      let total = 0
      for (const a of targets(account, 'mailRead')) {
        const q = from ? `from:${String(from).replace(/[^\w@.+\- ]/g, '')}` : ''
        const r = await d.google.unread(a.id, { max, query: q })
        total += r.total
        found.push(...r.messages.map((m) => ({ ...m, account: a.email })))
      }
      const first = found.slice(0, max)
      const spoken = first.length
        ? `You have ${total > first.length ? 'at least ' : ''}${total} unread. ` + first.slice(0, 3).map((m) => `${nameOf(m.from)}: ${m.subject || 'no subject'}`).join('. ') + '.'
        : from ? `No unread mail from ${from}.` : 'No unread mail.'
      return { spoken, data: first, untrusted: first.length > 0 }
    }
  })

  T.push({
    name: 'mail_read',
    tier: 'T0',
    description: 'Read one email (from mail_unread) by its id: sender, subject and the beginning of the text.',
    enabled: () => anyWith('mailRead'),
    schema: obj({ id: { type: 'string', minLength: 6, maxLength: 40 }, ...acctProp }, ['id']),
    run: async ({ id, account }) => {
      let lastErr
      for (const a of targets(account, 'mailRead')) {
        try {
          const m = await d.google.readMessage(a.id, id)
          return { spoken: `From ${nameOf(m.from)}. ${m.subject || 'No subject'}. ${m.body.slice(0, 400)}`, data: { ...m, account: a.email }, untrusted: true }
        } catch (e) {
          lastErr = e
        }
      }
      throw lastErr || new Error('I could not find that message')
    }
  })

  T.push({
    name: 'mail_send',
    tier: 'T2',
    title: 'Send an email',
    description: 'Send a plain-text email to ONE address from a connected Google account. The user sees the whole message and must approve it first. Cannot be undone.',
    enabled: () => anyWith('mailSend'),
    schema: obj({ to: { type: 'string', minLength: 5, maxLength: 120 }, subject: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 5000 }, ...acctProp }, ['to', 'subject', 'body']),
    describe: (a) => `Send an email${a.account ? ` from ${a.account}` : ''}\nTo: ${a.to}\nSubject: ${a.subject}\n\n${a.body}\n\n(This cannot be undone.)`,
    run: async ({ to, subject, body, account }) => {
      const [a] = targets(account, 'mailSend', { write: true })
      await d.google.send(a.id, { to, subject, body })
      return { spoken: `Sent to ${to}.`, data: { from: a.email, to } }
    }
  })

  T.push({
    name: 'calendar_events',
    tier: 'T0',
    description: 'List calendar events for today, tomorrow or the next seven days from the connected Google accounts.',
    enabled: () => anyWith('calendar'),
    schema: obj({ when: { type: 'string', enum: ['today', 'tomorrow', 'next_7_days'] }, ...acctProp }, ['when']),
    run: async ({ when: w, account }) => {
      const r = when(w, now())
      const all = []
      for (const a of targets(account, 'calendar')) all.push(...(await d.google.events(a.id, { from: r.from, to: r.to })).map((e) => ({ ...e, account: a.email })))
      all.sort((x, y) => new Date(x.start) - new Date(y.start))
      const spoken = all.length
        ? `You have ${all.length} event${all.length === 1 ? '' : 's'} ${r.label}: ` + all.slice(0, 5).map((e) => `${e.title} at ${timeOf(e)}`).join(', ') + '.'
        : w === 'today' ? 'Nothing else on your calendar today.' : `Nothing on your calendar ${r.label}.`
      return { spoken, data: all, untrusted: all.length > 0 }
    }
  })

  T.push({
    name: 'calendar_add',
    tier: 'T1',
    description: 'Add an event to the calendar (no guests are invited). start is the local date and time, for example 2026-10-25T16:00.',
    enabled: () => anyWith('calendar'),
    schema: obj(
      { title: { type: 'string', minLength: 1, maxLength: 200 }, start: { type: 'string', minLength: 10, maxLength: 30 }, duration_minutes: { type: 'integer', minimum: 5, maximum: 1440 }, description: { type: 'string', maxLength: 2000 }, ...acctProp },
      ['title', 'start']
    ),
    run: async ({ title, start, duration_minutes = 60, description, account }) => {
      const [a] = targets(account, 'calendar', { write: true })
      if (new Date(start).getTime() < now().getTime() - 60_000) throw new Error('that start time is in the past')
      const ev = await d.google.addEvent(a.id, { title, start, minutes: duration_minutes, description })
      return {
        spoken: `Added ${title} on ${new Date(ev.start).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} at ${timeOf(ev)}.`,
        data: ev,
        undoLabel: `calendar event ${title}`,
        undo: async () => {
          await d.google.deleteEvent(a.id, ev.id)
          return { spoken: 'Removed that event.' }
        }
      }
    }
  })

  return T
}

module.exports = { createGoogleTools, when, nameOf }
