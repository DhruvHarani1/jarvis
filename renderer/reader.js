'use strict'
/*
 * Notification Reader: Jarvis says new notifications out loud.
 *
 *   "Dhruv sir, you received a message from Mum on WhatsApp. The message is: dinner at eight."
 *
 * Part 1 (pure, unit-tested): how a notification becomes a sentence, what is worth reading, digests.
 * Part 2 (browser only): the live reader that listens to the inbox, respects focus time / being away, and talks.
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.ReaderCore = factory()
})(this, function () {
  const MESSAGE_APPS = /whatsapp|telegram|signal|discord|slack|teams|messenger|messages|skype|instagram|viber|wechat|snapchat|sms|imessage|phone link|zalo|kakao|\bline\b/i
  const EMAIL_APPS = /\bmail\b|outlook|gmail|proton|thunderbird|yahoo/i
  const CALENDAR_APPS = /calendar/i
  const SYSTEM_APPS = /^(windows|system|settings|security|defender|update)/i
  const CALL_WORDS = /\b(incoming (voice |video |group )?call|is calling|calling you|ringing|video call from|voice call from)\b/i
  const MISSED_CALL = /\bmissed\b/i

  /** apps whose notifications are not worth reading aloud by default (now-playing pings, vendor chatter) */
  const DEFAULT_MUTED = ['lyra', 'settings', 'system', 'lenovo', 'intel']

  // ------------------------------------------------------------ text cleaning
  const MEDIA = [
    [/^\s*(?:\u{1F4F7}|\u{1F5BC}️?)\s*(?:photo|image)?/iu, 'a photo'],
    [/^\s*(?:\u{1F3A5}|\u{1F4F9})\s*(?:video)?/iu, 'a video'],
    [/^\s*(?:\u{1F3A4}|\u{1F399}️?|\u{1F3A7})\s*(?:voice message|audio|\d+:\d+)?/iu, 'a voice message'],
    [/^\s*(?:\u{1F4C4}|\u{1F4CE})\s*(?:document|file)?/iu, 'a document'],
    [/^\s*\u{1F4CD}\s*(?:location)?/iu, 'a location'],
    [/^\s*(?:gif)\s*$/i, 'a GIF'],
    [/^\s*(?:sticker)\s*$/i, 'a sticker'],
    [/^\s*(?:photo|image)\s*$/i, 'a photo'],
    [/^\s*video\s*$/i, 'a video'],
    [/^\s*voice message\s*$/i, 'a voice message']
  ]

  /** words for what a media message contains, or null */
  function mediaOf(body) {
    for (const [re, label] of MEDIA) if (re.test(body) && body.replace(re, '').replace(/[\s\p{P}\p{S}]/gu, '').length < 3) return label
    return null
  }

  function stripEmoji(s) {
    return s
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200B-\u200F\u202A-\u202E\u2060\uFE0F\u200D]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** what a text-to-speech voice should be given: no markdown, no raw URLs, no emoji, no shouting repeats */
  function toSpeech(s) {
    let t = String(s ?? '')
    t = t.replace(/https?:\/\/\S+/gi, ' a link ').replace(/\bwww\.\S+/gi, ' a link ')
    t = t.replace(/[*_~`#>|]+/g, ' ')
    t = stripEmoji(t)
    t = t.replace(/([!?.,])\1{2,}/g, '$1') // "!!!!!" -> "!"
    t = t.replace(/(.)\1{4,}/g, '$1$1$1') // "heeeeeeey" -> "heeey"
    t = t.replace(/\s+/g, ' ').trim()
    return t
  }

  function truncate(s, max = 240) {
    if (s.length <= max) return s
    const cut = s.slice(0, max)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    const base = end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')
    return `${base} … and more.`
  }

  /** share of letters that are not Latin script (Hindi, Arabic, CJK …): an English voice would only garble them */
  function nonLatinShare(s) {
    const letters = [...s].filter((c) => /\p{L}/u.test(c))
    if (!letters.length) return 0
    const other = letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length
    return other / letters.length
  }

  function prettyApp(app) {
    const a = String(app || 'Windows').trim()
    const dom = /^([a-z0-9-]+)\.(com|org|net|io|co|tv|app|in)$/i.exec(a)
    if (dom) {
      const w = dom[1].toLowerCase()
      const known = { youtube: 'YouTube', google: 'Google', github: 'GitHub', linkedin: 'LinkedIn', whatsapp: 'WhatsApp', instagram: 'Instagram', twitter: 'Twitter', x: 'X', facebook: 'Facebook' }
      return known[w] || w.charAt(0).toUpperCase() + w.slice(1)
    }
    if (/^whats\s?app/i.test(a)) return 'WhatsApp'
    return a
  }

  function classify(item) {
    const app = String(item.app || '')
    const text = `${item.title || ''} ${item.body || ''}`
    if (CALL_WORDS.test(text) && !MISSED_CALL.test(text)) return 'call'
    if (CALENDAR_APPS.test(app)) return 'calendar'
    if (EMAIL_APPS.test(app)) return 'email'
    if (MESSAGE_APPS.test(app)) return 'message'
    if (SYSTEM_APPS.test(app)) return 'system'
    return 'generic'
  }

  const stripCount = (t) => t.replace(/\s*\(\d+\s+(?:new\s+)?(?:messages?|notifications?)\)\s*$/i, '').trim()

  /**
   * Turn one notification into what Jarvis says.
   * @param {{app:string,title:string,body?:string}} item
   * @param {{name?:string, mode?:'full'|'private'}} [o]
   * @returns {{text:string, caption:string, kind:string, urgent:boolean, who:string, app:string}}
   */
  function phrase(item, o = {}) {
    const name = String(o.name || '').trim()
    const addr = name ? `${name}, ` : ''
    const priv = o.mode === 'private'
    const app = prettyApp(item.app)
    const kind = classify(item)
    let title = toSpeech(stripCount(String(item.title || '')))
    const rawBody = String(item.body || '')
    let who = title
    const out = { kind, urgent: false, app, who }

    if (kind === 'call') {
      who = toSpeech(title.replace(CALL_WORDS, '').replace(/[:\-–—]+\s*$/, '')) || title || 'someone'
      out.who = who
      out.urgent = true
      out.text = `${addr}${who} is calling you on ${app}.`
      out.caption = `${who.toUpperCase()} IS CALLING ON ${app.toUpperCase()}`
      return out
    }

    if (kind === 'message') {
      let sender = title
      let group = ''
      let body = rawBody
      const g = /^([^:\n]{1,40}):\s+([\s\S]+)$/.exec(rawBody)
      if (g && !title.includes(':')) {
        sender = toSpeech(g[1])
        group = title
        body = g[2]
      }
      const media = mediaOf(body)
      let content = media ? `${media}` : toSpeech(body)
      if (!sender) sender = 'someone'
      out.who = sender
      const where = `${group ? ` in ${group}` : ''} on ${app}`
      if (priv) {
        out.text = `${addr}you received a message from ${sender}${where}.`
        out.caption = `MESSAGE FROM ${sender.toUpperCase()}`
        return out
      }
      if (!content) {
        out.text = `${addr}you received a message from ${sender}${where}.`
      } else if (media) {
        out.text = `${addr}you received a message from ${sender}${where}. They sent ${media}.`
      } else if (nonLatinShare(content) > 0.4) {
        out.text = `${addr}you received a message from ${sender}${where}. The message is not in English, so I left it on screen.`
      } else {
        out.text = `${addr}you received a message from ${sender}${where}. The message is: ${truncate(content)}`
      }
      out.caption = `${sender.toUpperCase()} (${app.toUpperCase()}): ${content ? truncate(content, 90).toUpperCase() : 'NEW MESSAGE'}`
      return out
    }

    const body = toSpeech(rawBody)
    if (kind === 'email') {
      out.who = title || 'someone'
      out.text = priv || !body ? `${addr}you have a new email from ${out.who} on ${app}.` : `${addr}you have a new email from ${out.who} on ${app}. The subject is: ${truncate(body, 160)}`
      out.caption = `EMAIL FROM ${out.who.toUpperCase()}`
      return out
    }

    if (kind === 'calendar') {
      out.text = priv ? `${addr}you have a calendar reminder.` : `${addr}calendar reminder: ${[title, truncate(body, 160)].filter(Boolean).join('. ')}`
      out.caption = `CALENDAR: ${title.toUpperCase()}`
      return out
    }

    if (kind === 'system') {
      out.text = priv ? `${addr}Windows has a notice for you.` : `${addr}Windows says: ${[title, truncate(body, 160)].filter(Boolean).join('. ')}`
      out.caption = `WINDOWS: ${title.toUpperCase()}`
      return out
    }

    // generic
    if (nonLatinShare(`${title} ${body}`) > 0.4 && !priv) {
      out.text = `${addr}new notification from ${app}. It is not in English, so I left it on screen.`
    } else if (priv) {
      out.text = `${addr}new notification from ${app}.`
    } else {
      out.text = `${addr}new notification from ${app}. ${[title, truncate(body, 160)].filter(Boolean).join('. ')}`
    }
    out.caption = `${app.toUpperCase()}: ${title.toUpperCase()}`
    return out
  }

  // ------------------------------------------------------------ what is worth reading
  const norm = (s) => String(s || '').toLowerCase().trim()

  function isMuted(item, muted) {
    const app = norm(prettyApp(item.app))
    const raw = norm(item.app)
    return (muted || []).some((m) => {
      const x = norm(m)
      return x && (x === app || x === raw || app.includes(x) || raw.includes(x))
    })
  }

  /** decides what to read from a batch: drops muted apps, stale items and repeats. `seen` is a Map(key → time). */
  function select(items, cfg, now, seen) {
    const out = []
    for (const it of items) {
      if (!it || typeof it.title !== 'string') continue
      if (isMuted(it, cfg.muted)) continue
      if (now - (it.at || now) > (cfg.maxAgeMs ?? 3 * 60_000)) continue
      const key = `${norm(it.app)}|${norm(it.title)}|${norm(it.body)}`
      const last = seen.get(key)
      if (last !== undefined && now - last < (cfg.dedupeMs ?? 60_000)) continue
      seen.set(key, now)
      out.push(it)
    }
    for (const [k, t] of seen) if (now - t > 10 * 60_000) seen.delete(k)
    return out
  }

  /**
   * One spoken summary for many notifications.
   * @param {object[]} items
   * @param {{name?:string, mode?:string, reason?:'away'|'focus'|'burst'}} o
   */
  function digest(items, o = {}) {
    const name = String(o.name || '').trim()
    const n = items.length
    if (!n) return ''
    const counts = new Map()
    for (const it of items) counts.set(prettyApp(it.app), (counts.get(prettyApp(it.app)) || 0) + 1)
    const groups = [...counts].sort((a, b) => b[1] - a[1])
    const shown = groups.slice(0, 4).map(([a, c]) => `${c} from ${a}`)
    if (groups.length > 4) shown.push('and a few others')
    const intro =
      o.reason === 'away' ? `Welcome back${name ? `, ${name}` : ''}. While you were away, you received ` : o.reason === 'focus' ? `Focus session over${name ? `, ${name}` : ''}. While you were focused, you received ` : `${name ? `${name}, ` : ''}you received `
    let text = `${intro}${n} notification${n === 1 ? '' : 's'}: ${shown.join(', ')}.`
    if (o.mode !== 'private') {
      const last = phrase(items[items.length - 1], { mode: 'private' })
      if (last.who && last.kind !== 'generic') text += ` The latest is from ${last.who} on ${last.app}.`
    }
    return text + ' Say "what did I miss" to hear them.'
  }

  /** the short form used when reading several notifications in a row ("what did I miss") */
  function brief(item, o = {}) {
    const p = phrase(item, { mode: o.mode, name: '' })
    if (p.kind === 'message') {
      const full = p.text.replace(/^you received a message from /, '')
      return full.replace(/ on ([^.]+)\. The message is: /, ' on $1: ').replace(/ on ([^.]+)\.$/, ' on $1.')
    }
    return p.text
  }

  return { phrase, digest, brief, select, isMuted, toSpeech, truncate, stripEmoji, nonLatinShare, prettyApp, classify, mediaOf, DEFAULT_MUTED }
})

// ------------------------------------------------------------------ live reader (browser only)
;(function () {
  if (typeof window === 'undefined' || !window.Core || !window.Inbox) return
  const R = window.ReaderCore
  const seen = new Map()
  let pending = [] // collected while you are away or focusing
  let last = null // the last thing read, for "repeat that"
  let wasAway = false
  let wasFocus = false

  const cfg = () => {
    const s = window.Core.getSettings()
    return { on: !!s.readNotifications, name: s.callMe || '', mode: s.readMode === 'private' ? 'private' : 'full', muted: s.readMuted || R.DEFAULT_MUTED }
  }
  const idleS = () => {
    const st = window.Core.snapshot().stats
    return st && Number.isFinite(st.idleS) ? st.idleS : 0
  }
  const focusing = () => {
    const t = window.Core.snapshot().timer
    return !!(t && t.running && t.mode === 'focus')
  }
  const talk = (text, o = {}) => window.jarvis.speak(text, { queue: true, ...o })

  function readNow(items) {
    const c = cfg()
    for (const it of items) {
      const p = R.phrase(it, { name: c.name, mode: c.mode })
      last = it
      talk(p.text, { urgent: p.urgent, tag: p.caption })
    }
  }

  /** called by the inbox with notifications that just arrived */
  function onNew(items) {
    const c = cfg()
    if (!c.on || !items || !items.length) return
    const fresh = R.select(items, { muted: c.muted }, Date.now(), seen)
    if (!fresh.length) return
    const calls = fresh.filter((i) => R.classify(i) === 'call')
    const rest = fresh.filter((i) => R.classify(i) !== 'call')
    if (calls.length) readNow(calls) // a ringing call is always announced
    if (!rest.length) return
    if (wasAway || focusing()) {
      pending.push(...rest)
      return
    }
    if (rest.length > 3) talk(R.digest(rest, { name: c.name, mode: c.mode, reason: 'burst' }), { tag: `${rest.length} NEW NOTIFICATIONS` })
    else readNow(rest)
  }

  function flush(reason) {
    const c = cfg()
    const items = pending.splice(0)
    if (!c.on || !items.length) return
    talk(R.digest(items, { name: c.name, mode: c.mode, reason }), { tag: `${items.length} NOTIFICATIONS WHILE YOU WERE ${reason === 'focus' ? 'FOCUSED' : 'AWAY'}` })
  }

  /** "what did I miss": the unread inbox, one short line each */
  function missed() {
    const c = cfg()
    const items = window.Inbox.unread().slice(0, 5)
    if (!items.length) {
      window.Core.say('NO UNREAD NOTIFICATIONS.', 6000, true)
      return 0
    }
    window.jarvis.speak(`${c.name ? `${c.name}, ` : ''}you have ${window.Inbox.unread().length} unread. `, { queue: false })
    for (const it of items.slice().reverse()) talk(R.brief(it, { mode: c.mode }), { tag: R.phrase(it, { mode: c.mode }).caption })
    return items.length
  }

  function repeat() {
    if (!last) {
      window.Core.say('NOTHING TO REPEAT YET.', 5000, true)
      return false
    }
    const c = cfg()
    const p = R.phrase(last, { name: c.name, mode: c.mode })
    window.jarvis.speak(p.text, { queue: false, tag: p.caption })
    return true
  }

  // away / focus transitions
  setInterval(() => {
    const away = idleS() >= 180
    const focus = focusing()
    if (wasAway && !away && idleS() < 15) flush('away')
    if (wasFocus && !focus && !away) flush('focus')
    wasAway = away
    wasFocus = focus
  }, 2000)

  window.jarvis.onSpeechStart((tag) => window.Core.say(tag, 9000, false))
  window.Reader = { onNew, flush, missed, repeat, get pending() { return pending }, get last() { return last } }
  if (window.Core.test) window.__reader = { onNew, flush, missed, repeat, setAway: (v) => (wasAway = v), seen, get pending() { return pending } }
})()
