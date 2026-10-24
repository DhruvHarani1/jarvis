'use strict'
/**
 * WhatsApp and Teams, honestly: neither offers a personal-account API that is safe to use, so Jarvis works the way a person does.
 *   send      open the chat with the message already typed (a documented link), check that the right app is in front, press Enter
 *   read      the Windows notification inbox Jarvis already keeps (what the apps showed as toasts)
 *   contacts  names to numbers and addresses, kept in the local memory database; a model only ever sees names
 *
 * A keystroke is only sent when, a moment before, the foreground window belongs to the app we meant (WhatsApp, Teams). Otherwise
 * the message is left typed and Jarvis says so. Sending is always confirmed first, with the full text and the real number.
 */
const PS_SEND_KEY = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class JarvisFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
}
'@
function Get-Fg { $h = [JarvisFg]::GetForegroundWindow(); $p = 0; [void][JarvisFg]::GetWindowThreadProcessId($h, [ref]$p); try { (Get-Process -Id $p).ProcessName } catch { '' } }
$allowed = @($arg.allowed)
$deadline = (Get-Date).AddMilliseconds([int]$arg.waitMs)
$name = ''
while ((Get-Date) -lt $deadline) { $name = Get-Fg; if ($allowed -contains $name) { break }; Start-Sleep -Milliseconds 200 }
$sent = $false
if ($allowed -contains $name) {
  Start-Sleep -Milliseconds ([int]$arg.settleMs)
  if ([bool]$arg.enter -and ($allowed -contains (Get-Fg))) { [JarvisFg]::keybd_event(0x0D, 0, 0, 0); [JarvisFg]::keybd_event(0x0D, 0, 2, 0); $sent = $true }
}
[pscustomobject]@{ foreground = $name; matched = ($allowed -contains $name); sent = $sent } | ConvertTo-Json -Compress`

const WHATSAPP_PROCESSES = ['WhatsApp.Root', 'WhatsApp']
const TEAMS_PROCESSES = ['ms-teams', 'MSTeams', 'Teams']
const JOIN_HOSTS = /^(teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|([a-z0-9-]+\.)?zoom\.us)$/i
const JOIN_URL = /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|(?:[a-z0-9-]+\.)?zoom\.us)\/[^\s<>"')]+/i

const PHONE_RE = /^\+[1-9]\d{7,14}$/
const EMAIL_RE = /^[^\s@<>,;"'()\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/
const obj = (properties, required = []) => ({ type: 'object', properties, required })

const cleanPhone = (s) => {
  const t = String(s || '').replace(/[\s().-]/g, '')
  return PHONE_RE.test(t) ? t : ''
}
const maskPhone = (p) => (p.length > 6 ? p.slice(0, 3) + ' ' + '•'.repeat(p.length - 6) + p.slice(-3) : p)

/** @param {{memory:any, ps:(s:string,a?:any)=>Promise<string>, shell:{openExternal:(u:string)=>Promise<any>}, recentNotifications:()=>any[], google?:any, store?:any, now?:()=>number}} d */
function createChatTools(d) {
  const T = []
  const now = d.now || Date.now

  /** a person's WhatsApp number or Teams address: contact name, or a number / address given directly */
  function resolve(to, kind) {
    const raw = String(to || '').trim()
    if (kind === 'phone') {
      const direct = cleanPhone(raw)
      if (direct) return { ok: true, value: direct, label: maskPhone(direct) }
    } else if (EMAIL_RE.test(raw)) return { ok: true, value: raw, label: raw }
    const c = d.memory.findContact(raw)
    if (c === 'many') return { ok: false, error: `more than one contact matches "${raw}"; say the full name` }
    if (!c) return { ok: false, error: `I do not have ${raw} saved. Say "save contact ${raw} number +91…" (or email) first, or give me the full number` }
    const v = kind === 'phone' ? c.phone : c.email
    if (!v) return { ok: false, error: `${c.name} has no ${kind === 'phone' ? 'WhatsApp number' : 'email address'} saved` }
    return { ok: true, value: v, label: `${c.name} (${kind === 'phone' ? maskPhone(v) : v})` }
  }

  T.push({
    name: 'whatsapp_send',
    tier: 'T2',
    title: 'Send a WhatsApp message',
    description: 'Send a WhatsApp message to a saved contact (by name) or a full international number. The user sees the recipient and the exact text and must approve. Cannot be undone.',
    schema: obj({ to: { type: 'string', minLength: 1, maxLength: 60 }, text: { type: 'string', minLength: 1, maxLength: 500 } }, ['to', 'text']),
    describe: (a) => {
      const r = resolve(a.to, 'phone')
      return `WhatsApp message\nTo: ${r.ok ? r.label : a.to + ' (not found)'}\n\n${a.text}\n\n(This cannot be undone.)`
    },
    run: async ({ to, text }) => {
      const r = resolve(to, 'phone')
      if (!r.ok) throw new Error(r.error)
      await d.shell.openExternal(`whatsapp://send?phone=${r.value.replace('+', '')}&text=${encodeURIComponent(text)}`)
      const res = JSON.parse(await d.ps(PS_SEND_KEY, { allowed: WHATSAPP_PROCESSES, enter: true, waitMs: 8000, settleMs: 1300 }))
      return res.sent
        ? { spoken: `Sent to ${r.label.split(' (')[0]}.`, data: { to: r.label } }
        : { spoken: 'I opened the chat with your message typed in, but WhatsApp was not in front, so I did not press Enter. Press Enter to send it.', data: { to: r.label, sent: false } }
    }
  })

  T.push({
    name: 'teams_message',
    tier: 'T2',
    title: 'Send a Teams message',
    description: 'Send a Microsoft Teams chat message to a saved contact (needs an email on file) or an email address. The user sees the recipient and the exact text and must approve. If the Teams app is not open, the message is only typed into the chat in the browser.',
    schema: obj({ to: { type: 'string', minLength: 1, maxLength: 80 }, text: { type: 'string', minLength: 1, maxLength: 500 } }, ['to', 'text']),
    describe: (a) => {
      const r = resolve(a.to, 'email')
      return `Teams message\nTo: ${r.ok ? r.label : a.to + ' (not found)'}\n\n${a.text}\n\n(This cannot be undone.)`
    },
    run: async ({ to, text }) => {
      const r = resolve(to, 'email')
      if (!r.ok) throw new Error(r.error)
      await d.shell.openExternal(`https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(r.value)}&message=${encodeURIComponent(text)}`)
      const res = JSON.parse(await d.ps(PS_SEND_KEY, { allowed: TEAMS_PROCESSES, enter: true, waitMs: 6000, settleMs: 1500 }))
      return res.sent
        ? { spoken: `Sent to ${r.label.split(' (')[0]}.`, data: { to: r.label } }
        : { spoken: 'I opened the Teams chat with your message typed in. The Teams app was not in front, so I did not press Enter; click send.', data: { to: r.label, sent: false } }
    }
  })

  if (d.google && d.store) {
    T.push({
      name: 'meeting_join_next',
      tier: 'T2',
      title: 'Join a meeting',
      description: 'Open the join link of the meeting that is on now or starts within the next two hours (Teams, Google Meet or Zoom link found in the calendar event). The user must approve; it opens the meeting in the app or browser.',
      enabled: () => d.store.list('google').some((a) => !a.needsSignIn && d.google.has(a, 'calendar')),
      schema: obj({}),
      describe: () => 'Join your next meeting (the join link from your calendar will be opened).',
      run: async () => {
        const from = new Date(now() - 30 * 60_000)
        const to = new Date(now() + 2 * 3600_000)
        const found = []
        for (const a of d.store.list('google').filter((x) => !x.needsSignIn && d.google.has(x, 'calendar'))) found.push(...(await d.google.events(a.id, { from, to })))
        const trusted = (l) => {
          try {
            const u = new URL(l)
            return u.protocol === 'https:' && JOIN_HOSTS.test(u.hostname)
          } catch {
            return false
          }
        }
        const ev = found.filter((e) => e.join && trusted(e.join)).sort((x, y) => new Date(x.start) - new Date(y.start))[0]
        if (!ev) return { spoken: 'I do not see a meeting with a join link in the next two hours.' }
        const u = new URL(ev.join)
        if (u.protocol !== 'https:' || !JOIN_HOSTS.test(u.hostname)) throw new Error('that meeting link is not one I trust')
        await d.shell.openExternal(u.href)
        return { spoken: `Joining ${ev.title}.`, data: { title: ev.title, host: u.hostname } }
      }
    })
  }

  T.push({
    name: 'read_notifications',
    tier: 'T0',
    description: 'Read the latest Windows notifications (for example WhatsApp or Teams messages that arrived), optionally for one app or one sender.',
    schema: obj({ app: { type: 'string', maxLength: 30 }, from: { type: 'string', maxLength: 40 }, max: { type: 'integer', minimum: 1, maximum: 8 } }),
    run: async ({ app, from, max = 4 }) => {
      let items = d.recentNotifications()
      if (app) items = items.filter((i) => String(i.app).toLowerCase().includes(app.toLowerCase()))
      if (from) items = items.filter((i) => String(i.title).toLowerCase().includes(from.toLowerCase()))
      items = items.slice(-max).reverse()
      if (!items.length) return { spoken: 'I have no recent notifications like that.', data: [] }
      return { spoken: items.map((i) => `${i.title} on ${i.app}${i.body ? ': ' + i.body : ''}`).join('. ') + '.', data: items.map((i) => ({ app: i.app, title: i.title, body: i.body, at: i.at })), untrusted: true }
    }
  })

  T.push({
    name: 'contact_save',
    tier: 'T1',
    description: 'Save or update a contact: a name with a WhatsApp number in international format (+91…) and/or an email address (used for Teams). Stored only on this PC.',
    schema: obj({ name: { type: 'string', minLength: 1, maxLength: 40 }, phone: { type: 'string', maxLength: 30 }, email: { type: 'string', maxLength: 120 } }, ['name']),
    run: async ({ name, phone, email }) => {
      if (!phone && !email) throw new Error('give a number or an email to save')
      const p = phone ? cleanPhone(phone) : ''
      if (phone && !p) throw new Error('I need the number with its country code, like +91 98765 43210')
      if (email && !EMAIL_RE.test(email)) throw new Error('that does not look like an email address')
      const prev = d.memory.findContact(name)
      const r = d.memory.saveContact({ name, phone: p || (prev && prev !== 'many' ? prev.phone : ''), email: email || (prev && prev !== 'many' ? prev.email : '') })
      if (!r.ok) throw new Error(r.error)
      return {
        spoken: `Saved ${r.contact.name}.`,
        undoLabel: 'saving that contact',
        undo: async () => {
          if (r.previous) d.memory.saveContact(r.previous)
          else d.memory.deleteContact(r.contact.id)
          return { spoken: 'Contact change undone.' }
        }
      }
    }
  })

  T.push({
    name: 'contact_list',
    tier: 'T0',
    description: 'List the saved contacts (names only) and whether each has a WhatsApp number and/or a Teams email.',
    schema: obj({}),
    run: async () => {
      const l = d.memory.listContacts()
      if (!l.length) return { spoken: 'You have no saved contacts yet.', data: [] }
      return { spoken: `You have ${l.length} saved: ` + l.slice(0, 8).map((c) => c.name).join(', ') + '.', data: l.map((c) => ({ name: c.name, whatsapp: !!c.phone, teams: !!c.email })) }
    }
  })

  T.push({
    name: 'contact_remove',
    tier: 'T1',
    description: 'Delete a saved contact by name.',
    schema: obj({ name: { type: 'string', minLength: 1, maxLength: 40 } }, ['name']),
    run: async ({ name }) => {
      const c = d.memory.findContact(name)
      if (c === 'many') throw new Error('more than one contact matches; say the full name')
      if (!c) return { spoken: `I do not have ${name} saved.` }
      const gone = d.memory.deleteContact(c.id)
      return { spoken: `Removed ${gone.name}.`, undoLabel: 'removing that contact', undo: async () => (d.memory.saveContact(gone), { spoken: `${gone.name} is back.` }) }
    }
  })

  return T
}

module.exports = { createChatTools, PS_SEND_KEY, cleanPhone, maskPhone, JOIN_URL, JOIN_HOSTS, WHATSAPP_PROCESSES, TEAMS_PROCESSES }
