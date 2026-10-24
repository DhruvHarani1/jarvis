'use strict'
/*
 * The Jarvis window: chat log, caption, typed input. Provides the small Core that voice.js / inbox.js / reader.js talk to,
 * and Assistant.handle(text): what happens when you say or type something.
 */
;(function () {
  const $ = (id) => document.getElementById(id)
  const log = $('log')
  const caption = $('caption')
  const input = $('input')
  const test = new URLSearchParams(location.search).get('test') === '1'
  let settings = { jarvisSpeaks: true, readNotifications: false, readMode: 'full', callMe: '', readMuted: [] }
  let voiceTurn = false
  let busy = false
  let capTimer = 0

  // ---------------------------------------------------------------- Core: what voice.js / inbox.js / reader.js use
  function say(text, ms = 12000, forceSpeak = false, silent = false) {
    caption.textContent = text
    clearTimeout(capTimer)
    capTimer = setTimeout(() => (caption.textContent = ''), ms)
    if (!silent && (settings.jarvisSpeaks || forceSpeak)) window.jarvis.speak(text)
  }
  function setUnread(_kind, n) {
    document.body.dataset.unread = n ? '1' : '0'
  }
  window.jarvis.onAssistantLine((text) => addLine('jarvis', String(text || '')))

  window.Core = {
    say,
    setUnread,
    getSettings: () => settings,
    snapshot: () => ({ stats: null, timer: null }), // Jarvis has no PC sensors: Spidey Sense does
    test
  }

  function addLine(who, text) {
    const li = document.createElement('li')
    if (who === 'me') li.className = 'me'
    li.textContent = text
    log.append(li)
    while (log.children.length > 60) log.firstChild.remove()
    log.scrollTop = log.scrollHeight
  }

  const patch = (p) => window.jarvis.patchSettings(p)
  const off = /\b(off|stop|disable|don'?t|no longer|turn off|quit)\b/

  // ---------------------------------------------------------------- local commands (everything else goes to the brain)
  async function command(text) {
    const t = text.toLowerCase().replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim()
    if (/\b(api keys?|ai (settings|brain|keys?)|brain (settings|keys)|set ?up (the |my |an? )?(ai|brain|api)|add (an? )?(api )?key|open (the )?brain)\b/.test(t)) {
      window.jarvis.openBrain()
      return 'Opening my brain settings.'
    }
    if (/\b(new chat|start (a )?new (chat|conversation)|forget (this|our|the) (chat|conversation)|start over|reset (the )?(chat|conversation))\b/.test(t)) {
      window.jarvis.brainReset()
      log.replaceChildren()
      return 'Fresh start. What shall we talk about?'
    }
    if (/^(stop|stop talking|be quiet|quiet|shut up|enough)$/.test(t)) {
      window.jarvis.stopSpeaking()
      return ''
    }
    if (/\b(what did i miss|any (new )?notifications)\b/.test(t) && !/\b(read|stop)\b/.test(t) && window.Reader) {
      window.Reader.missed()
      return ''
    }
    if (/\b(repeat that|say that again|what was that)\b/.test(t) && window.Reader) {
      window.Reader.repeat()
      return ''
    }
    if (/\b(read|reading)\b.*\bnotifications?\b/.test(t) || /\bnotifications?\b.*\b(aloud|out loud)\b/.test(t)) {
      if (/\b(privately|private)\b/.test(t)) {
        patch({ readNotifications: true, readMode: 'private' })
        return 'I will read who the notification is from, but not what it says.'
      }
      const on = !off.test(t)
      patch({ readNotifications: on, readMode: 'full' })
      return on ? 'I will read your new notifications aloud.' : 'I will stay quiet about notifications.'
    }
    if (/\b(wake ?word|hey jarvis|always listen(ing)?)\b/.test(t) && !/\b(what|how)\b/.test(t)) {
      const on = !off.test(t)
      patch({ wakeWord: on })
      return on
        ? 'Wake word on. Say "Hey Jarvis", wait for the beep, then ask. Windows listens on this PC only, nothing is recorded or sent.'
        : 'Wake word off. I am not listening for my name any more.'
    }
    if (/\b(conversation mode|keep listening|hands free)\b/.test(t)) {
      const on = !off.test(t)
      patch({ voiceConverse: on })
      return on ? 'Conversation mode on. I will listen again after each answer.' : 'Conversation mode off.'
    }
    if (/\b(change|switch|next) (your |the )?voice\b/.test(t)) {
      const v = await window.jarvis.pickVoice('next')
      return v ? '' : 'I only have one voice installed.'
    }
    const vm = /\buse (zira|david|mark|hazel)\b/.exec(t)
    if (vm) {
      await window.jarvis.pickVoice(vm[1])
      return ''
    }
    if (/\bcheck for updates?\b/.test(t)) {
      const r = await window.jarvis.updateCheck().catch(() => null)
      return r && r.state === 'ready' ? 'An update is downloaded. Use the tray menu to restart and install it.' : 'I checked: you are up to date.'
    }
    return null
  }

  async function handle(text, opts = {}) {
    text = String(text || '').trim()
    if (!text) return
    voiceTurn = !!opts.voice
    addLine('me', text)
    if (window.Confirm && window.Confirm.tryVoice(text)) return // a spoken yes / no to a question he just asked
    try {
      const local = await command(text)
      if (local !== null) {
        if (local) {
          addLine('jarvis', local)
          say(local, 8000, voiceTurn)
        }
        return
      }
      // everyday commands (open an app, volume, timers, media keys, undo) need no language model
      const fast = await window.jarvis.fastTry(text).catch(() => null)
      if (fast && fast.handled) {
        addLine('jarvis', fast.say)
        say(fast.say, 8000, voiceTurn)
        return
      }
      const ok = await window.jarvis.brainReady().catch(() => false)
      if (!ok) {
        const m = 'I have no brain connected yet. Say "API keys" to add a free key, or install Ollama for a local model.'
        addLine('jarvis', m)
        say(m, 12000, voiceTurn)
        return
      }
      busy = true
      say('…', 30000, false, true)
      let ans
      try {
        ans = await window.jarvis.brainChat(text, { unread: window.Inbox ? window.Inbox.unread().length : 0 }, { speak: voiceTurn || !!settings.jarvisSpeaks })
      } catch {
        ans = null
      }
      busy = false
      if (!ans || !ans.ok) {
        const m = 'My brain hiccupped' + (ans && ans.error ? ' (' + String(ans.error) + ')' : '') + '. Say "API keys" to check my keys.'
        addLine('jarvis', m)
        say(m, 10000, false, true)
        return
      }
      addLine('jarvis', ans.say)
      caption.textContent = ''
    } finally {
      voiceTurn = false
      busy = false
    }
  }

  // the reply appears word by word while it is being written
  window.jarvis.onBrainDelta((t) => say(t, 20000, false, true))
  const applySettings = (s) => {
    settings = { ...settings, ...s }
    document.body.dataset.wake = s.wakeWord ? '1' : '0'
  }
  window.jarvis.onSettings(applySettings)
  window.jarvis.getSettings().then(applySettings)
  window.jarvis.onFocusInput(() => input.focus())

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key !== 'Enter' || !input.value.trim() || busy) return
    const v = input.value
    input.value = ''
    void handle(v)
  })
  $('brainbtn').addEventListener('click', () => window.jarvis.openBrain())
  $('acctbtn').addEventListener('click', () => window.jarvis.openAccounts())
  $('menubtn').addEventListener('click', () => window.jarvis.showMenu())
  $('hidebtn').addEventListener('click', () => window.jarvis.hide())

  window.Assistant = { handle, command }
  input.focus()
})()
