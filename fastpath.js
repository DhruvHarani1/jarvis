'use strict'
/**
 * The fast path: everyday commands that need no language model ("open Spotify", "volume 30", "set a timer for 5 minutes",
 * "remind me in 20 minutes to stretch", "next song", "undo"). Answered locally, instantly, offline and for free.
 * Anything it does not clearly recognise returns null and goes to the language model.
 *
 * Returns { kind: 'tool', name, args } | { kind: 'say', text } | { kind: 'undo' } | null. Tools still go through the
 * tool runtime, so tiers, confirmation and the activity log apply exactly as for the model.
 */

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 }
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const WEB = { youtube: 'https://www.youtube.com/', gmail: 'https://mail.google.com/', google: 'https://www.google.com/', 'google maps': 'https://maps.google.com/', maps: 'https://maps.google.com/', whatsapp: null, github: 'https://github.com/', chatgpt: 'https://chatgpt.com/' }

/** "twenty five" / "25" / "a" / "an" / "half an" -> number, or null */
function num(s) {
  const t = String(s || '').trim().toLowerCase().replace(/-/g, ' ')
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'a' || t === 'an' || t === 'one') return 1
  if (t === 'half an' || t === 'half a' || t === 'half') return 0.5
  if (t === 'a half' || t === 'one and a half') return 1.5
  const parts = t.split(/\s+/)
  if (parts.length === 1 && t in ONES) return ONES[t]
  if (parts.length === 1 && t in TENS) return TENS[t]
  if (parts.length === 2 && parts[0] in TENS && parts[1] in ONES && ONES[parts[1]] > 0 && ONES[parts[1]] < 10) return TENS[parts[0]] + ONES[parts[1]]
  return null
}
const UNIT = { second: 1 / 60, seconds: 1 / 60, sec: 1 / 60, secs: 1 / 60, minute: 1, minutes: 1, min: 1, mins: 1, hour: 60, hours: 60, hr: 60, hrs: 60 }
const NUMRE = '(\\d+(?:\\.\\d+)?|(?:twenty|thirty|forty|fifty|sixty)[ -](?:one|two|three|four|five|six|seven|eight|nine)|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|an?|half an?|an? half|one and a half)'
const UNITRE = '(seconds?|secs?|minutes?|mins?|hours?|hrs?)'

function minutesOf(n, unit) {
  const v = num(n)
  const u = UNIT[String(unit).toLowerCase()]
  if (v === null || !u) return null
  return Math.round(v * u * 1000) / 1000
}

function clean(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[?!.,"“”]/g, ' ')
    .replace(/’/g, "'")
    .replace(/\b(hey |ok |okay )?jarvis\b/g, ' ')
    .replace(/\b(please|could you|can you|would you|will you|kindly|for me|now)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** @param {string} raw @param {{now?:Date}} [o] */
function parse(raw, o = {}) {
  const t = clean(raw)
  if (!t || t.split(' ').length > 14) return null
  let m

  if (/^(undo|undo that|undo it|take that back|revert that|put it back)$/.test(t)) return { kind: 'undo' }

  if ((m = new RegExp(`^(?:set |start |make )?(?:a |an )?(?:timer|countdown)(?: for| of)? ${NUMRE} ?${UNITRE}$`).exec(t)) || (m = new RegExp(`^(?:set |start )?(?:a |an )?${NUMRE} ?${UNITRE} (?:timer|countdown)$`).exec(t))) {
    const min = minutesOf(m[1], m[2])
    if (min && min >= 0.1 && min <= 1440) return { kind: 'tool', name: 'set_timer', args: { minutes: min } }
  }

  // "remind me in 20 minutes to stretch" / "remind me to stretch in 20 minutes"
  if ((m = new RegExp(`^remind me in ${NUMRE} ?${UNITRE} (?:to |that |about )?(.+)$`).exec(t))) {
    const min = minutesOf(m[1], m[2])
    if (min && min >= 0.1 && min <= 525600) return { kind: 'tool', name: 'add_reminder', args: { text: m[3], in_minutes: min } }
  }
  if ((m = new RegExp(`^remind me (?:to |that |about )(.+?) in ${NUMRE} ?${UNITRE}$`).exec(t))) {
    const min = minutesOf(m[2], m[3])
    if (min && min >= 0.1 && min <= 525600) return { kind: 'tool', name: 'add_reminder', args: { text: m[1], in_minutes: min } }
  }

  if (/^(what time is it|what's the time|what is the time|tell me the time|the time|time)$/.test(t)) {
    const d = o.now || new Date()
    return { kind: 'say', text: `It is ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.` }
  }
  if (/^(what(?:'s| is) (?:the )?(?:date|day)(?: today)?|what day is it(?: today)?|today's date)$/.test(t)) {
    const d = o.now || new Date()
    return { kind: 'say', text: `It is ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.` }
  }

  if ((m = new RegExp(`^(?:set )?(?:the )?(?:system )?volume(?: to| at)? ${NUMRE}(?: percent| %)?$`).exec(t)) || (m = new RegExp(`^(?:turn|set) (?:the )?(?:sound|volume) (?:to|at) ${NUMRE}(?: percent)?$`).exec(t))) {
    const v = num(m[1])
    if (v !== null && v >= 0 && v <= 100 && Number.isInteger(v)) return { kind: 'tool', name: 'set_volume', args: { level: v } }
  }
  if (/^(volume up|turn (?:it |the volume |the sound )?up|louder|increase (?:the )?volume)$/.test(t)) return { kind: 'tool', name: 'media_key', args: { action: 'volume_up', times: 5 } }
  if (/^(volume down|turn (?:it |the volume |the sound )?down|quieter|lower (?:the )?volume|decrease (?:the )?volume)$/.test(t)) return { kind: 'tool', name: 'media_key', args: { action: 'volume_down', times: 5 } }
  if (/^(mute|mute (?:the )?(?:sound|volume|pc|computer)|silence)$/.test(t)) return { kind: 'tool', name: 'mute', args: { muted: true } }
  if (/^(unmute|unmute (?:the )?(?:sound|volume|pc|computer))$/.test(t)) return { kind: 'tool', name: 'mute', args: { muted: false } }

  if (/^(pause|resume|play|pause (?:the )?(?:music|song|video|track|playback)|play (?:the )?(?:music|song|video|track)|resume (?:the )?(?:music|song|video|track|playback)|stop (?:the )?music)$/.test(t)) return { kind: 'tool', name: 'media_key', args: { action: 'play_pause' } }
  if (/^(next|skip|next (?:song|track)|skip (?:this |the )?(?:song|track))$/.test(t)) return { kind: 'tool', name: 'media_key', args: { action: 'next' } }
  if (/^(previous|go back|previous (?:song|track)|last (?:song|track))$/.test(t)) return { kind: 'tool', name: 'media_key', args: { action: 'previous' } }

  if (/^(system status|how(?:'s| is) my (?:pc|computer|laptop|system)(?: doing)?|pc status|computer status|how(?:'s| is) the pc|battery|battery level|how much battery(?: do i have| is left)?|cpu usage)$/.test(t)) return { kind: 'tool', name: 'system_status', args: {} }
  if (/^(what(?:'s| are) my reminders|list (?:my )?reminders|list (?:my )?timers|show (?:my )?reminders)$/.test(t)) return { kind: 'tool', name: 'list_reminders', args: {} }

  // screen understanding (always asks first; off until switched on in the tray)
  if (/^(?:what(?:'s| is) on my screen|what(?:'s| is) on the screen|look at (?:my|the) screen|read (?:my|the) screen|what am i looking at|describe (?:my|the) screen)$/.test(t)) return { kind: 'tool', name: 'look_at_screen', args: { question: 'Describe what is on the screen and read out anything important.' } }
  if (/^what does this (?:error|message|warning|popup|dialog)(?: message)? say$/.test(t)) return { kind: 'tool', name: 'look_at_screen', args: { question: 'What does the error message on the screen say, and what should I do about it?' } }

  // the morning briefing
  if (/^(?:good morning|morning|morning briefing|brief me|give me (?:my |the )?(?:morning )?(?:briefing|brief|rundown|summary)|(?:what(?:'s| is) (?:my|the) day(?: looking)? like|what does my day look like|how(?:'s| is) my day(?: looking)?)(?: today)?|catch me up|my briefing)$/.test(t)) return { kind: 'tool', name: 'morning_briefing', args: {} }

  // memory (the original wording is kept, so names keep their capitals)
  const said = String(raw || '').trim().replace(/^(?:hey |ok |okay )?jarvis[, ]+/i, '').replace(/^please /i, '').replace(/[?!]+$/, '')
  if ((m = /^(?:remember|make a note|take a note|note down|note)(?: that| this| down that)?:? (.{3,300})$/i.exec(said)) && !/^(to |how |what |why |when |where )/i.test(m[1])) return { kind: 'tool', name: 'remember', args: { text: m[1].replace(/[.]+$/, '') } }
  if (/^(?:what do you (?:remember|know about me)|what have i told you|what(?:'s| is) in your memory|list (?:your )?memor(?:y|ies))$/.test(t)) return { kind: 'tool', name: 'recall', args: {} }
  if ((m = /^what do you (?:remember|know) about (.{2,80})$/.exec(t))) return { kind: 'tool', name: 'recall', args: { query: m[1] } }
  if (/^(?:forget everything|forget all of it|erase (?:all )?(?:your )?memory|wipe (?:all )?(?:your )?memory|clear (?:your )?memory|delete (?:all )?(?:your )?memory)$/.test(t)) return { kind: 'tool', name: 'forget_everything', args: {} }
  if ((m = /^forget (?:about )?(.{2,80})$/.exec(t)) && !/^(everything|all)/.test(m[1])) return { kind: 'tool', name: 'forget', args: { query: m[1] } }

  // Power mode: only by saying so explicitly (the command text is kept as typed)
  if ((m = /^(?:run|execute) (?:the )?(?:powershell|shell|command)(?: command)?:? (.{2,500})$/i.exec(said))) return { kind: 'tool', name: 'run_powershell', args: { command: m[1].trim() } }

  // WhatsApp, Teams, contacts, meetings (the app must be named; always confirmed before anything is sent)
  const who = (x) => String(x).trim().replace(/^(?:my|to)\s+/i, '')
  if ((m = /^(?:send (?:a )?)?whatsapp(?: message)? (?:to )?(.{1,40}?) (?:saying|that|:) (.{1,500})$/i.exec(said)) || (m = /^(?:message|text|tell|send) (.{1,40}?) on whatsapp (?:saying |that |: ?)?(.{1,500})$/i.exec(said))) return { kind: 'tool', name: 'whatsapp_send', args: { to: who(m[1]), text: m[2].trim() } }
  if ((m = /^(?:send (?:a )?)?teams(?: message)? (?:to )?(.{1,40}?) (?:saying|that|:) (.{1,500})$/i.exec(said)) || (m = /^(?:message|chat|tell|send) (.{1,40}?) on teams (?:saying |that |: ?)?(.{1,500})$/i.exec(said))) return { kind: 'tool', name: 'teams_message', args: { to: who(m[1]), text: m[2].trim() } }
  if (/^join (?:my |the )?(?:next )?(?:meeting|call|teams call|teams meeting|online meeting)$/.test(t)) return { kind: 'tool', name: 'meeting_join_next', args: {} }
  if ((m = /^what did (.{1,40}?) (?:say|send|write|message|text)(?: me)?(?: on (whatsapp|teams))?$/.exec(t))) return { kind: 'tool', name: 'read_notifications', args: m[2] ? { from: who(m[1]), app: m[2] } : { from: who(m[1]) } }
  if (/^(?:read|check|any|do i have any|show) (?:my )?(?:new )?(whatsapp|teams)(?: messages| notifications)?$/.test(t)) return { kind: 'tool', name: 'read_notifications', args: { app: /whatsapp/.test(t) ? 'whatsapp' : 'teams' } }
  if ((m = /^(?:save|add) (?:contact )?(.{1,40}?)(?:'s)? (?:whatsapp )?(?:phone )?number(?: is| as)? (\+[\d ()-]{8,22})$/i.exec(said))) return { kind: 'tool', name: 'contact_save', args: { name: who(m[1]), phone: m[2].trim() } }
  if ((m = /^(?:save|add) (?:contact )?(.{1,40}?)(?:'s)? (?:teams |work )?e-?mail(?: address)?(?: is| as)? (\S+@\S+)$/i.exec(said))) return { kind: 'tool', name: 'contact_save', args: { name: who(m[1]), email: m[2].trim() } }
  if (/^(?:list|show|what are) (?:my )?contacts$/.test(t)) return { kind: 'tool', name: 'contact_list', args: {} }

  // mail and calendar (need a connected Google account; main says so when there is none)
  if (/^(check (?:my )?(?:e-?mails?|mail|inbox)|(?:any|do i have (?:any )?)(?: ?new| ?unread)? ?(?:e-?mails?|mail|messages)(?: today)?|(?:read )?my (?:unread )?(?:e-?mails?|mail|inbox)|unread (?:e-?mails?|mail)|what(?:'s| is) in my inbox|have i got (?:any )?(?:new )?(?:e-?mails?|mail))$/.test(t)) return { kind: 'tool', name: 'mail_unread', args: {} }
  if ((m = /^(?:what(?:'s| is| do i have)? (?:on )?(?:my )?(?:calendar|schedule|agenda)|what do i have|do i have any (?:meetings|events|appointments)|my (?:calendar|schedule|agenda)|(?:read|show) (?:me )?my (?:calendar|schedule|agenda)|any (?:meetings|events|appointments))(?: for)?(?: (today|tomorrow|this week|next seven days|next 7 days|the next week))?$/.exec(t))) {
    const w = m[1] === 'tomorrow' ? 'tomorrow' : !m[1] || m[1] === 'today' ? 'today' : 'next_7_days'
    return { kind: 'tool', name: 'calendar_events', args: { when: w } }
  }

  // Spotify (free account: names open the search, links play directly)
  if (/^(what(?:'s| is) playing|what song is (?:this|playing)|what(?:'s| is) this song|which song is this|what am i listening to|now playing)(?: on spotify)?$/.test(t)) return { kind: 'tool', name: 'spotify_now_playing', args: {} }
  if (/^(open|play|show) (?:my )?liked songs(?: on spotify)?$/.test(t)) return { kind: 'tool', name: 'spotify_open_liked_songs', args: {} }
  if ((m = /^(?:search spotify for|search for|find) (.{2,80}?) (?:on|in) spotify$/.exec(t)) || (m = /^(?:search spotify for|spotify search(?: for)?) (.{2,80})$/.exec(t)) || (m = /^(?:play|put on|queue|find) (.{2,80}?) (?:on|in|from|using) spotify$/.exec(t))) return { kind: 'tool', name: 'spotify_search', args: { query: m[1].trim() } }

  // a pasted Spotify link or URI (IDs are case sensitive, so look at the raw text)
  const bare = String(raw || '').trim().replace(/^(?:hey |ok |okay )?jarvis[, ]+/i, '').replace(/^please /i, '').replace(/[?!.]+$/, '')
  if ((m = /^play (\S+)$/i.exec(bare)) && /^(spotify:|https:\/\/open\.spotify\.com\/)/i.test(m[1])) return { kind: 'tool', name: 'spotify_play', args: { link: m[1] } }

  if ((m = /^(?:open|launch|start|run) (?:the )?(.{2,40}?)(?: app| application)?$/.exec(t))) {
    const what = m[1].trim()
    if (/^(timer|a timer|the timer|focus|conversation|wake|listening|notifications)/.test(what)) return null
    if (what in WEB && WEB[what]) return { kind: 'tool', name: 'open_url', args: { url: WEB[what] } }
    return { kind: 'tool', name: 'open_app', args: { name: what } }
  }
  return null
}

module.exports = { parse, num, clean }
