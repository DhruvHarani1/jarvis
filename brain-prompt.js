'use strict'
/**
 * What Jarvis's "brain" is told and how its answer is understood. Pure functions (unit-tested).
 *
 * Privacy: the model only ever sees what you typed/said plus ONE short status line (time, CPU/RAM, timer…).
 * Notification contents, file names and the like are never put in a prompt.
 */

/** Commands the model may trigger. Each is run through Jarvis's own rule engine, so it can do nothing a typed command could not. */
const ALLOWED_ACTIONS = new Set([
  'remind', 'timer', 'collapse', 'sound', 'opacity', 'voice', 'voice-pick', 'voice-list', 'speak-test',
  'reader', 'reader-mode', 'reader-mute', 'call-me', 'missed', 'repeat', 'speech-stop', 'reader-status',
  'locker', 'equip', 'bugle', 'edith', 'capture', 'help-window', 'update-check', 'brain-open', 'brain-reset'
])
// never allowed from a model: ending processes (kill / its confirmation) and installing updates

/** example commands shown to the model, so it can map "remind me in a bit" to something the rule engine understands */
const DO_EXAMPLES = [
  'in 20m stretch', 'at 3pm call mum', 'start focus', 'take a break', 'pause the timer', 'reset timer', 'collapse',
  'mute', 'unmute', 'opacity 70', 'am i safe', 'daily web', 'take a screenshot', 'show my level', 'wear the neon suit',
  'check for updates', 'read my notifications', 'stop reading notifications', 'read notifications privately',
  "don't read youtube", 'read whatsapp again', 'call me Dhruv sir', 'what did i miss', 'repeat that', 'change voice',
  'use david', 'speak to me', 'stop talking', 'open the manual'
]

const clamp = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

/** one line of live context (no private content) */
function contextLine(c = {}) {
  const parts = []
  const d = c.now instanceof Date ? c.now : new Date()
  parts.push(`It is ${d.toLocaleDateString('en-US', { weekday: 'long' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`)
  const s = c.stats
  if (s) {
    const bits = []
    if (Number.isFinite(s.cpu)) bits.push(`CPU ${Math.round(s.cpu)}%`)
    if (Number.isFinite(s.ram)) bits.push(`RAM ${Math.round(s.ram)}%`)
    if (Number.isFinite(s.disk)) bits.push(`disk ${Math.round(s.disk)}%`)
    if (s.online === false) bits.push('offline')
    else if (Number.isFinite(s.latencyMs)) bits.push(`ping ${Math.round(s.latencyMs)} ms`)
    if (s.hog && typeof s.hog.name === 'string') bits.push(`biggest app ${clamp(s.hog.name, 30)} ${Number(s.hog.mb) || 0} MB`)
    if (bits.length) parts.push(`PC: ${bits.join(', ')}.`)
  }
  const b = c.battery
  if (b && b.present) parts.push(`Battery ${Math.round(b.level * 100)}%${b.charging ? ' charging' : ''}.`)
  const t = c.timer
  if (t && Number.isFinite(t.left)) parts.push(`Timer: ${t.mode} ${t.running ? 'running' : 'paused'}, ${Math.floor(t.left / 60)}m ${t.left % 60}s left.`)
  if (Number.isFinite(c.unread)) parts.push(`Unread notifications: ${c.unread}.`)
  if (Number.isFinite(c.level)) parts.push(`XP level ${c.level}.`)
  return parts.join(' ')
}

/**
 * @param {{name?:string}} o
 * @returns {string}
 */
function systemPrompt(o = {}) {
  const name = clamp(o.name, 40)
  return [
    'You are Jarvis, the friendly AI voice assistant on the user’s Windows PC. Talk like a warm, quick-witted friend, never like a manual.',
    'Your replies are SPOKEN ALOUD: one to three short sentences, plain words, no markdown, no emoji, no lists, no stage directions.',
    name ? `Address the user as "${name}" now and then, not in every sentence.` : 'You do not know the user’s name yet; if it feels natural, ask what to call them.',
    'Use the context line for real PC facts. Never invent numbers, files, messages or events. If you do not know, say so briefly.',
    ...(o.actions === false
      ? ['You cannot act on the PC yet: you can only talk. If asked to do something, say that is not something you can do for now. Reply with ONLY the words you say out loud.']
      : [
        'You can also act. If (and only if) the user clearly asks you to do something, put ONE short command in "do", worded like one of: ' + DO_EXAMPLES.map((x) => `"${x}"`).join(', ') + '. Otherwise leave "do" empty.',
        'You cannot close programs, change system settings, open files or run anything else. If asked, say you cannot do that.',
        'Reply with ONLY the words you say out loud. If you need to act, add one final separate line that starts with DO: followed by the command, for example DO: in 20m stretch. Never write anything after that line.'
        ])
  ].join(' ')
}

/**
 * @param {{role:string,content:string}[]} history previous turns (already short)
 * @param {string} userText
 * @param {{name?:string, ctx?:object, actions?:boolean}} o
 */
function buildMessages(history, userText, o = {}) {
  const ctx = contextLine(o.ctx || {})
  return [
    { role: 'system', content: systemPrompt({ name: o.name, actions: o.actions }) + (ctx ? `\nContext: ${ctx}` : '') },
    ...history.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clamp(m.content, 500) })),
    { role: 'user', content: clamp(userText, 600) }
  ]
}

/** models often wrap JSON in prose, code fences or <think> blocks: pull out {say, do}, or treat the whole reply as speech */
function parseReply(raw) {
  let t = String(raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```(?:json)?/gi, ' ')
    .trim()
  if (!t) return { say: '', do: '' }
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(t.slice(a, b + 1))
      if (j && typeof j === 'object') {
        const say = clamp(j.say ?? j.reply ?? j.text ?? '', 420)
        const cmd = clamp(j.do ?? j.action ?? j.command ?? '', 80)
        if (say || cmd) return { say, do: typeof j.do === 'string' || typeof j.action === 'string' || typeof j.command === 'string' ? cmd : '' }
      }
    } catch {
      /* not JSON after all */
    }
  }
  // plain speech with an optional final "DO: command" line
  let cmd = ''
  const dm = /(?:^|\n)\s*DO:\s*(.*)$/i.exec(t)
  if (dm) {
    cmd = clamp(dm[1], 80)
    t = t.slice(0, dm.index).trim()
  }
  // plain prose: speak it (cut at a sentence end if it is long)
  let say = clamp(t.replace(/^["']|["']$/g, ''), 420)
  if (say.length > 380) {
    const cut = Math.max(say.lastIndexOf('. ', 380), say.lastIndexOf('! ', 380), say.lastIndexOf('? ', 380))
    if (cut > 120) say = say.slice(0, cut + 1)
  }
  return { say, do: cmd }
}

const ABBREV = /(?:^|\s)(?:mr|mrs|ms|dr|prof|vs|etc|e\.g|i\.e|approx|no|st)$/i

/**
 * Feeds on the reply as it streams in and calls onSentence(text) as soon as a sentence is complete,
 * so Jarvis can start talking before the model has finished writing.
 *  - the trailing "DO: command" line is never spoken
 *  - <think>…</think> blocks are skipped
 *  - a reply that starts with "{" (JSON) is not streamed; it is parsed once at the end
 */
function createReplyStream({ onSentence, minFirst = 18, min = 30 } = {}) {
  let raw = ''
  let emitted = 0
  let mode = null
  let sentCount = 0

  function speechPart() {
    let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    const open = t.search(/<think>/i)
    if (open >= 0) t = t.slice(0, open) // still inside a think block: wait
    const m = /(?:^|\n)\s*DO:/i.exec(t)
    if (m) t = t.slice(0, m.index)
    return t
  }

  function drain(final) {
    const t = speechPart()
    let from = emitted
    for (let i = from; i < t.length; i++) {
      const c = t[i]
      const next = t[i + 1]
      const isEnd = c === '\n' || ('.!?…'.includes(c) && (next === undefined ? final : /\s/.test(next)))
      if (!isEnd) continue
      if (c === '.' && (/\d$/.test(t.slice(0, i)) && /^\d/.test(next || '') || ABBREV.test(t.slice(from, i)))) continue
      const candidate = t.slice(from, i + 1).trim()
      // short sentences are merged with the next one (choppy speech sounds robotic); only the very last one may be short
      if (candidate.length < (sentCount === 0 ? minFirst : min) && !(final && i === t.length - 1)) continue
      if (candidate) {
        onSentence && onSentence(candidate.replace(/\s+/g, ' '))
        sentCount++
      }
      from = i + 1
      emitted = from
    }
    if (final) {
      const rest = t.slice(emitted).trim()
      if (rest) {
        onSentence && onSentence(rest.replace(/\s+/g, ' '))
        sentCount++
      }
      emitted = t.length
    }
  }

  return {
    feed(delta) {
      raw += String(delta ?? '')
      if (mode === null) {
        const s = raw.trimStart()
        if (s) mode = s[0] === '{' || s.startsWith('```') ? 'json' : 'plain'
      }
      if (mode === 'plain') drain(false)
    },
    /** @returns {{say:string, do:string, streamed:boolean}} */
    end() {
      if (mode === 'plain') drain(true)
      const r = parseReply(raw)
      return { ...r, streamed: mode === 'plain' && sentCount > 0 }
    },
    get raw() {
      return raw
    }
  }
}

const isAllowedAction = (type) => ALLOWED_ACTIONS.has(String(type))

module.exports = { systemPrompt, buildMessages, parseReply, createReplyStream, contextLine, isAllowedAction, ALLOWED_ACTIONS, DO_EXAMPLES, clamp }
