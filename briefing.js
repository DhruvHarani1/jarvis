'use strict'
/**
 * The morning briefing: what the day looks like, put together on this PC from your calendar, unread mail, reminders and the
 * notifications that arrived. It is composed by plain code, not by an AI model, so nothing about your day is sent to a provider,
 * it works offline, and it is the same every time. A source that cannot be read is skipped and mentioned, never guessed.
 */

const part = (h) => (h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening')
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const senderName = (from) => ((/^"?([^"<]+?)"?\s*</.exec(from) || [])[1] || String(from || '').replace(/<.*$/, '').trim() || 'someone').slice(0, 40)
const short = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1).trimEnd() + '…' : String(s))

/**
 * @param {{events?:{title:string,start:string,allDay?:boolean}[]|null, unread?:{total:number, latest?:{from:string,subject:string}}|null, reminders?:{text:string,at:number}[], notifications?:Record<string,number>, battery?:{percent:number,charging:boolean}|null, failed?:string[]}} data
 * @param {{name?:string, now?:Date}} o
 * @returns {{spoken:string, lines:string[]}}
 */
function compose(data, { name = '', now = new Date() } = {}) {
  const lines = []
  const greet = `Good ${part(now.getHours())}${name ? ', ' + name : ''}. It is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${clock(now)}.`
  lines.push(greet)

  if (data.events) {
    const ev = data.events
    if (!ev.length) lines.push('Your calendar is clear for the rest of today.')
    else {
      const list = ev.slice(0, 3).map((e) => `${short(e.title, 50)} ${e.allDay ? 'all day' : 'at ' + clock(new Date(e.start))}`)
      const more = ev.length > 3 ? `, and ${ev.length - 3} more` : ''
      lines.push(ev.length === 1 ? `You have one event today: ${list[0]}.` : `You have ${ev.length} events today: ${list.join(', then ')}${more}.`)
    }
  }
  if (data.unread) {
    const u = data.unread
    if (!u.total) lines.push('No unread mail.')
    else lines.push(`You have ${plural(u.total, 'unread email', 'unread emails')}${u.latest ? `, the latest from ${senderName(u.latest.from)}: ${short(u.latest.subject || 'no subject', 60)}` : ''}.`)
  }
  const rem = (data.reminders || []).filter((r) => new Date(r.at).toDateString() === now.toDateString())
  if (rem.length) lines.push(`You have ${plural(rem.length, 'reminder', 'reminders')} today: ${rem.slice(0, 2).map((r) => `${short(r.text, 40)} at ${clock(new Date(r.at))}`).join(', ')}${rem.length > 2 ? `, and ${rem.length - 2} more` : ''}.`)
  const n = Object.entries(data.notifications || {}).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])
  if (n.length) lines.push(`${n.reduce((s, [, c]) => s + c, 0)} notifications came in: ${n.slice(0, 3).map(([app, c]) => `${c} on ${app}`).join(', ')}.`)
  if (data.battery && !data.battery.charging && data.battery.percent <= 30) lines.push(`Battery is at ${data.battery.percent} percent; you may want to plug in.`)
  for (const f of data.failed || []) lines.push(`I could not read your ${f} just now.`)
  return { spoken: lines.join(' '), lines }
}

/**
 * Collect the data. Every source is optional and isolated: one failure never ruins the briefing.
 * @param {{google?:any, store?:any, scheduler?:{list:()=>any[]}, notifications?:()=>any[], battery?:()=>Promise<any>, now?:Date, sinceMs?:number}} d
 */
async function gather(d) {
  const now = d.now || new Date()
  const failed = []
  const out = { events: null, unread: null, reminders: [], notifications: {}, battery: null, failed }
  const accounts = d.google && d.store ? d.store.list('google').filter((a) => !a.needsSignIn) : []

  const cal = accounts.filter((a) => d.google.has(a, 'calendar'))
  if (cal.length) {
    try {
      const end = new Date(now)
      end.setHours(23, 59, 59, 0)
      const all = []
      for (const a of cal) all.push(...(await d.google.events(a.id, { from: now, to: end })))
      out.events = all.sort((x, y) => new Date(x.start) - new Date(y.start))
    } catch {
      failed.push('calendar')
    }
  }
  const mail = accounts.filter((a) => d.google.has(a, 'mailRead'))
  if (mail.length) {
    try {
      let total = 0
      let latest
      for (const a of mail) {
        const r = await d.google.unread(a.id, { max: 1 })
        total += r.total
        if (!latest && r.messages[0]) latest = { from: r.messages[0].from, subject: r.messages[0].subject }
      }
      out.unread = { total, latest }
    } catch {
      failed.push('mail')
    }
  }
  try {
    out.reminders = d.scheduler ? d.scheduler.list() : []
  } catch {
    /* none */
  }
  try {
    const since = now.getTime() - (d.sinceMs || 12 * 3600_000)
    for (const n of d.notifications ? d.notifications() : []) if (n.at >= since) out.notifications[n.app] = (out.notifications[n.app] || 0) + 1
  } catch {
    /* none */
  }
  try {
    out.battery = d.battery ? await d.battery() : null
  } catch {
    /* no battery info is not worth mentioning */
  }
  return out
}

module.exports = { compose, gather, senderName }
