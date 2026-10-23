'use strict'
const { app, BrowserWindow, dialog, utilityProcess, safeStorage, session, shell, globalShortcut, Menu, Notification, Tray, ipcMain, nativeImage, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const autostart = require('./autostart')
const speechSapi = require('./speech')
const audioModels = require('./audio/models')
const audioClient = require('./audio/client')
const pcm = require('./audio/pcm')
const voiceOut = require('./voice-out')
const stt = require('./stt')
const wakeWord = require('./wake')
const { createBrain, PRESETS: BRAIN_PRESETS } = require('./brain')
const brainPrompt = require('./brain-prompt')
const { updater } = require('./updater')
const karenLlm = require('./karen-llm')
const notifications = require('./notifications')

const APP_ID = 'dev.jarvis.assistant'
const SIZE = { w: 380, h: 580 }
const MARGIN = 20

const DEFAULTS = {
  alwaysOnTop: false,
  startup: true, // launch at login (per-user); the tray toggle turns it off
  startupDefaulted: false,
  jarvisSpeaks: true, // replies are spoken aloud (voice turns are always spoken)
  voiceConverse: false, // after he answers a spoken question, listen again for a follow-up
  wakeWord: false, // "Hey Jarvis": always listening for the wake phrase, fully offline
  neuralVoice: true, // use the natural on-PC voice when its model is installed (else the Windows voice)
  sttMode: 'auto', // 'auto' = Groq Whisper if you have a Groq key, else Windows | 'offline' = Windows only
  voiceName: '', // '' = automatic; otherwise the exact installed Windows voice name
  readNotifications: false, // read new notifications aloud
  readMode: 'full', // 'full' = who and what | 'private' = who only
  callMe: '', // how Jarvis addresses you, e.g. "Dhruv sir"
  readMuted: ['settings', 'system', 'lenovo', 'intel'], // apps never read aloud
  llmModel: '', // preferred Ollama model (blank = auto)
  inbox: true, // mirror Windows notifications into the inbox (local only)
  trayHinted: false,
  position: null
}

// ---------------------------------------------------------------- settings
let settings = { ...DEFAULTS }

// ---------------------------------------------------------------- audio worker (speech model, voice, wake word) and Jarvis's voice
const audio = audioClient.create({ fork: (p) => utilityProcess.fork(p, [], { serviceName: 'Jarvis audio' }), workerPath: path.join(__dirname, 'audio', 'worker.js'), userDir: () => app.getPath('userData') })
const speech = voiceOut.create({
  speech: speechSapi,
  audio,
  send: (channel, payload) => win?.webContents.send(channel, payload),
  ready: () => audioModels.ready('voice'),
  enabled: () => settings.neuralVoice
})
let settingsFile = ''
let saveTimer = null

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }
  } catch {
    settings = { ...DEFAULTS }
  }
  if (!settings.startupDefaulted) {
    settings.startup = true
    settings.startupDefaulted = true
    saveSettings()
  }
}

function saveSettings() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
    } catch (e) {
      console.warn('could not save settings', e.message)
    }
  }, 300)
}

function update(patch) {
  settings = { ...settings, ...patch }
  saveSettings()
  applySettings()
  win?.webContents.send('settings', publicSettings())
  buildTray()
}

const publicSettings = () => ({
  jarvisSpeaks: settings.jarvisSpeaks,
  voiceName: settings.voiceName,
  voiceConverse: settings.voiceConverse,
  sttMode: settings.sttMode,
  wakeWord: settings.wakeWord,
  readNotifications: settings.readNotifications,
  readMode: settings.readMode,
  callMe: settings.callMe,
  readMuted: settings.readMuted
})

// ---------------------------------------------------------------- window
/** @type {BrowserWindow | null} */
let win = null
let tray = null
let stopInbox = null
let quitting = false

const iconPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, 'assets', 'icon.png'))

function clampToDisplay(x, y) {
  const wa = screen.getDisplayMatching({ x, y, width: SIZE.w, height: SIZE.h }).workArea
  return { x: Math.min(Math.max(x, wa.x), wa.x + wa.width - SIZE.w), y: Math.min(Math.max(y, wa.y), wa.y + wa.height - SIZE.h) }
}

function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - SIZE.w - MARGIN, y: wa.y + wa.height - SIZE.h - MARGIN }
}

function createWindow() {
  const pos = settings.position ? clampToDisplay(settings.position.x, settings.position.y) : defaultPosition()
  win = new BrowserWindow({
    width: SIZE.w,
    height: SIZE.h,
    ...pos,
    show: false,
    frame: false,
    backgroundColor: '#050b1a',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Jarvis',
    icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, autoplayPolicy: 'no-user-gesture-required' }
  })
  win.setMenuBarVisibility(false)
  win.on('system-context-menu', (e) => {
    e.preventDefault()
    showMenu()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.once('ready-to-show', () => {
    applySettings()
    // started by Windows at login: stay in the tray; started by hand: show the window
    if (!process.argv.includes('--autostart') || process.env.SPIDEY_TEST) win.show()
  })
  win.on('moved', () => {
    const [x, y] = win.getPosition()
    settings.position = { x, y }
    saveSettings()
  })
  // close (Alt+F4) hides to the tray; Quit lives in the tray menu
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), process.env.SPIDEY_TEST ? { query: { test: '1' } } : undefined)
}

function showWindow() {
  if (!win) return
  win.show()
  win.focus()
  win.webContents.send('focus-input')
}

function applySettings() {
  if (!win) return
  syncWake()
  win.setAlwaysOnTop(settings.alwaysOnTop)
  syncLoginItem(settings.startup)
}

/** Launch at login: HKCU Run entry, verified after writing and repaired on every start (see autostart.js). */
function syncLoginItem(enable) {
  if (!app.isPackaged || process.env.SPIDEY_TEST) return // tests must never touch the real startup entry
  autostart
    .sync({ enable, exe: process.execPath })
    .then((r) => {
      if (!r.ok) console.warn('launch at startup:', r.error)
    })
    .catch((e) => console.warn('launch at startup:', e.message))
}

// ---------------------------------------------------------------- tray + menu
let speechVoices = []

function updateMenuItem() {
  const s = updater.state
  if (s.state === 'ready') return { label: `Restart to update to v${s.version}`, click: () => updater.install() }
  if (s.state === 'downloading') return { label: `Downloading update… ${Math.round(s.percent || 0)}%`, enabled: false }
  if (s.state === 'checking') return { label: 'Checking for updates…', enabled: false }
  return { label: `Check for updates (v${app.getVersion()})`, click: () => void updater.check() }
}

/** ask first (what, where from, how big), then download, verify and install the voice models */
async function offerModels(bundles) {
  const items = []
  for (const b of bundles) for (const it of audioModels.missing(b).items) if (!items.some((x) => x.id === it.id)) items.push(it)
  if (!items.length) {
    void dialog.showMessageBox(win, { type: 'info', message: 'The voice models are already installed.' })
    return
  }
  const total = items.reduce((n, i) => n + i.bytes, 0)
  const detail = items.map((i) => `• ${i.title}: ${audioModels.prettyBytes(i.bytes)}\n  ${i.why}. License: ${i.license}\n  from ${new URL(i.url).host}`).join('\n')
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Download', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: `Download voice models (about ${audioModels.prettyBytes(total)})?`,
    detail: detail + '\n\nEach file is checked against a fixed checksum before it is used. Nothing else is downloaded or sent.'
  })
  if (r.response !== 0) return
  try {
    for (const it of items) {
      await audioModels.install(it.id, ({ got, total: t }) => win?.setProgressBar(t ? got / t : -1))
    }
    win?.setProgressBar(-1)
    void dialog.showMessageBox(win, { type: 'info', message: 'Voice models installed.', detail: 'Jarvis now understands you and speaks on this PC.' })
  } catch (e) {
    win?.setProgressBar(-1)
    void dialog.showMessageBox(win, { type: 'error', message: 'Could not install the voice models.', detail: String((e && e.message) || e) })
  }
  buildTray()
}

function menuTemplate() {
  const check = (label, key) => ({ label, type: 'checkbox', checked: !!settings[key], click: (i) => update({ [key]: i.checked }) })
  return [
    { label: win?.isVisible() ? 'Hide Jarvis' : 'Show Jarvis', click: () => (win?.isVisible() ? win.hide() : showWindow()) },
    { label: 'Talk to Jarvis (Ctrl+Alt+Space)', click: () => win?.webContents.send('voice:toggle') },
    { type: 'separator' },
    check('Jarvis speaks his replies', 'jarvisSpeaks'),
    check('Keep listening after he answers (conversation mode)', 'voiceConverse'),
    check('Wake word: say "Hey Jarvis" (always listening, offline)', 'wakeWord'),
    {
      label: 'Speech recognition',
      submenu: [
        { label: 'Automatic (Groq Whisper if you have a key, else Windows)', type: 'radio', checked: settings.sttMode === 'auto', click: () => update({ sttMode: 'auto' }) },
        { label: 'Windows only (offline, audio never leaves this PC)', type: 'radio', checked: settings.sttMode === 'offline', click: () => update({ sttMode: 'offline' }) }
      ]
    },
    {
      label: "Jarvis's voice",
      submenu: [
        { label: 'Automatic', type: 'radio', checked: !settings.voiceName, click: () => pickVoice('auto') },
        ...speechVoices.map((v) => ({ label: `${v.short} (${v.gender})`, type: 'radio', checked: settings.voiceName === v.name, click: () => pickVoice(v.name) }))
      ]
    },
    check('Natural voice (on this PC)', 'neuralVoice'),
    { label: 'Download voice models…', click: () => void offerModels(['stt', 'voice']) },
    { type: 'separator' },
    check('Notification inbox', 'inbox'),
    check('Read notifications aloud', 'readNotifications'),
    { label: 'Notification reading: private (who, not what)', type: 'checkbox', checked: settings.readMode === 'private', click: (i) => update({ readMode: i.checked ? 'private' : 'full' }) },
    { type: 'separator' },
    { label: 'AI brain: free API keys…', click: () => openBrain() },
    check('Always on top', 'alwaysOnTop'),
    check('Launch at startup', 'startup'),
    updateMenuItem(),
    { type: 'separator' },
    { label: 'Quit Jarvis', click: () => app.quit() }
  ]
}

function showMenu() {
  if (win) Menu.buildFromTemplate(menuTemplate()).popup({ window: win })
}

function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }))
    tray.setToolTip('Jarvis')
    tray.on('click', () => (win?.isVisible() ? win.hide() : showWindow()))
  }
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()))
}

ipcMain.on('menu:show', (e) => {
  if (e.sender === win?.webContents) showMenu()
})
ipcMain.on('window:hide', (e) => {
  if (e.sender === win?.webContents) win.hide()
})

const PATCHABLE = { jarvisSpeaks: 'boolean', voiceConverse: 'boolean', wakeWord: 'boolean', readNotifications: 'boolean' }
ipcMain.on('settings:patch', (e, patch) => {
  if (e.sender !== win?.webContents || !patch || typeof patch !== 'object') return
  const clean = {}
  for (const [k, type] of Object.entries(PATCHABLE)) if (typeof patch[k] === type) clean[k] = patch[k]
  if (patch.sttMode === 'auto' || patch.sttMode === 'offline') clean.sttMode = patch.sttMode
  if (patch.readMode === 'full' || patch.readMode === 'private') clean.readMode = patch.readMode
  if (typeof patch.callMe === 'string') clean.callMe = patch.callMe.replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40)
  if (Array.isArray(patch.readMuted)) {
    clean.readMuted = [...new Set(patch.readMuted.filter((x) => typeof x === 'string').map((x) => x.toLowerCase().replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40)).filter(Boolean))].slice(0, 40)
  }
  if (Object.keys(clean).length) update(clean)
})
ipcMain.handle('settings:get', () => publicSettings())

// ---------------------------------------------------------------- AI brain (multi-key failover → local Ollama)
/** @type {ReturnType<typeof createBrain> | null} */
let brain = null
let brainHistory = []
let brainReady = { at: 0, v: false }
/** @type {BrowserWindow | null} */
let brainWin = null

function initBrain() {
  brain = createBrain({
    file: path.join(app.getPath('userData'), 'brain.json'),
    fetch: (...a) => fetch(...a),
    crypt: {
      available: () => safeStorage.isEncryptionAvailable(),
      enc: (s) => safeStorage.encryptString(s).toString('base64'),
      dec: (b) => safeStorage.decryptString(Buffer.from(b, 'base64'))
    },
    ollama: { status: () => karenLlm.status(settings.llmModel) }
  })
}

ipcMain.handle('brain:ready', async (e) => {
  if (e.sender !== win?.webContents || !brain) return false
  if (Date.now() - brainReady.at < 15_000) return brainReady.v
  brainReady = { at: Date.now(), v: await brain.ready() }
  return brainReady.v
})

ipcMain.handle('brain:chat', async (e, text, ctx, opts) => {
  if (e.sender !== win?.webContents || !brain || typeof text !== 'string' || !text.trim()) return { ok: false, error: 'not available' }
  const speak = !!(opts && opts.speak === true)
  // Jarvis cannot act on the PC yet (Phase 1): conversation only
  const messages = brainPrompt.buildMessages(brainHistory, text, { name: settings.callMe, ctx: { now: new Date(), unread: Number.isFinite(ctx && ctx.unread) ? ctx.unread : undefined }, actions: false })
  if (speak) speech.stop() // never talk over himself, or over you
  let said = ''
  const rs = brainPrompt.createReplyStream({
    onSentence: (s) => {
      said += (said ? ' ' : '') + s
      if (speak) void speech.speak(s, { queue: true })
      win?.webContents.send('brain:delta', said)
    }
  })
  const r = await brain.chat(messages, (d) => rs.feed(d))
  if (!r.ok) {
    brainReady = { at: 0, v: false }
    return { ok: false, error: r.error, chain: r.chain }
  }
  const fin = rs.end()
  if (!fin.say) return { ok: false, error: 'it sent an empty answer' }
  if (speak && !fin.streamed && fin.say) void speech.speak(fin.say, { queue: true })
  brainHistory.push({ role: 'user', content: text.slice(0, 600) }, { role: 'assistant', content: fin.say })
  brainHistory = brainHistory.slice(-24)
  return { ok: true, say: fin.say, via: r.via, spoken: speak }
})
ipcMain.on('brain:reset', (e) => {
  if (e.sender === win?.webContents) brainHistory = []
})
ipcMain.on('brain:open', (e) => {
  if (e.sender === win?.webContents) openBrain()
})

const BRAIN_LINK_HOSTS = new Set([...Object.values(BRAIN_PRESETS).map((p) => (p.signup ? new URL(p.signup).hostname : '')).filter(Boolean), 'ollama.com'])

function openBrain() {
  if (brainWin) {
    brainWin.show()
    brainWin.focus()
    return
  }
  brainWin = new BrowserWindow({
    width: 700,
    height: 860,
    minWidth: 560,
    minHeight: 520,
    backgroundColor: '#050b1a',
    title: 'Jarvis — AI brain',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-brain.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  brainWin.setMenuBarVisibility(false)
  brainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  brainWin.webContents.on('will-navigate', (e) => e.preventDefault())
  brainWin.on('closed', () => {
    brainWin = null
    brainReady = { at: 0, v: false }
  })
  brainWin.loadFile(path.join(__dirname, 'renderer', 'brain.html'))
}

const fromBrainWin = (e) => !!brainWin && e.sender === brainWin.webContents && !!brain
const fail = (err) => ({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 200) })

ipcMain.handle('brainwin:state', async (e) => {
  if (!fromBrainWin(e)) return null
  return {
    entries: brain.list(),
    settings: brain.getSettings(),
    presets: Object.fromEntries(Object.entries(BRAIN_PRESETS).map(([id, p]) => [id, { name: p.name, baseUrl: p.baseUrl, models: p.models, signup: p.signup, hint: p.hint }])),
    ollama: await karenLlm.status(settings.llmModel).catch(() => ({ available: false, model: '' })),
    chain: brain.lastChain()
  }
})
ipcMain.handle('brainwin:add', (e, entry) => {
  if (!fromBrainWin(e) || !entry || typeof entry !== 'object') return fail('not allowed')
  try {
    const id = brain.add({ provider: String(entry.provider), key: String(entry.key || ''), label: String(entry.label || ''), model: String(entry.model || ''), baseUrl: String(entry.baseUrl || '') })
    brainReady = { at: 0, v: false }
    return { ok: true, id }
  } catch (err) {
    return fail(err)
  }
})
ipcMain.handle('brainwin:update', (e, id, patch) => {
  if (!fromBrainWin(e) || typeof id !== 'string' || !patch || typeof patch !== 'object') return fail('not allowed')
  try {
    const p = {}
    if (typeof patch.label === 'string') p.label = patch.label
    if (typeof patch.model === 'string') p.model = patch.model
    if (typeof patch.enabled === 'boolean') p.enabled = patch.enabled
    if (typeof patch.baseUrl === 'string') p.baseUrl = patch.baseUrl
    if (typeof patch.key === 'string') p.key = patch.key
    brain.update(id, p)
    brainReady = { at: 0, v: false }
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
})
ipcMain.handle('brainwin:remove', (e, id) => {
  if (!fromBrainWin(e) || typeof id !== 'string') return fail('not allowed')
  brain.remove(id)
  brainReady = { at: 0, v: false }
  return { ok: true }
})
ipcMain.handle('brainwin:move', (e, id, dir) => {
  if (!fromBrainWin(e) || typeof id !== 'string') return fail('not allowed')
  brain.move(id, dir < 0 ? -1 : 1)
  return { ok: true }
})
ipcMain.handle('brainwin:test', (e, id) => (fromBrainWin(e) && typeof id === 'string' ? brain.test(id) : fail('not allowed')))
ipcMain.handle('brainwin:natural', (e, on) => {
  if (!fromBrainWin(e)) return fail('not allowed')
  brain.setNaturalChat(!!on)
  brainReady = { at: 0, v: false }
  return { ok: true }
})
ipcMain.on('brainwin:link', (e, url) => {
  if (!fromBrainWin(e) || typeof url !== 'string') return
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' && BRAIN_LINK_HOSTS.has(u.hostname)) void shell.openExternal(u.href)
  } catch {
    /* ignore */
  }
})

// ---------------------------------------------------------------- voice: microphone audio in, text out
// what Windows' offline recogniser is told to expect (it also takes free dictation)
const STT_PHRASES = stt.buildPhrases({})
/** the speech model on this PC, when it is installed (tests use the fake provider path unless they ask for the real model) */
function localStt() {
  if (process.env.SPIDEY_TEST && !process.env.JARVIS_TEST_LOCAL_STT) return null
  if (!audioModels.ready('stt')) return null
  return async (wav) => {
    const p = pcm.wavToFloat32(wav)
    if (!p) return { ok: false, error: 'unreadable recording' }
    const r = await audio.transcribe(p.rate === 16000 ? p.samples : pcm.resample(p.samples, p.rate, 16000))
    return { ok: true, text: r.text }
  }
}
ipcMain.handle('stt:transcribe', async (e, audio) => {
  if (e.sender !== win?.webContents) return { ok: false, text: '', error: 'not allowed' }
  let buf
  try {
    buf = Buffer.from(audio instanceof ArrayBuffer ? new Uint8Array(audio) : audio)
  } catch {
    return { ok: false, text: '', error: 'bad audio' }
  }
  const res = await stt.transcribe(buf, { brain, mode: settings.sttMode, phrases: STT_PHRASES, local: localStt() })
  if (process.env.JARVIS_DEBUG) console.log('[stt]', JSON.stringify({ via: res.via, chain: res.chain, text: res.text }))
  return res
})
ipcMain.handle('voice:info', (e) => (e.sender === win?.webContents ? { cloud: !!brain && brain.canTranscribe(), mode: settings.sttMode, converse: settings.voiceConverse } : null))

let micOpen = false // the window has the microphone open for a question
let speaking = false
let wakeResume = null
const onWakeState = (s, detail) => win?.webContents.send('wake:state', { state: s, detail: detail || '' })
const onWoke = () => {
  wake.pause() // he must not hear his own beep and answer
  win?.webContents.send('voice:toggle')
}
const wakeLegacy = wakeWord.create({
  env: process.env.SPIDEY_TEST && process.env.SPIDEY_WAKE_WAV ? { SPIDEY_WAKE_WAV: process.env.SPIDEY_WAKE_WAV } : {},
  onWake: onWoke,
  onState: onWakeState
})
const wakeKws = require('./wake-kws').create({ audio, send: (channel, payload) => win?.webContents.send(channel, payload), onWake: onWoke, onState: onWakeState })
// the on-PC keyword spotter when its model is installed, otherwise the Windows speech recogniser (tests keep the old one unless asked)
const useKws = () => audioModels.ready('wake') && !(process.env.SPIDEY_TEST && !process.env.JARVIS_TEST_KWS)
let wakeImpl = wakeLegacy
const wake = {
  start() {
    const next = useKws() ? wakeKws : wakeLegacy
    if (next !== wakeImpl) wakeImpl.stop()
    wakeImpl = next
    wakeImpl.start()
  },
  stop: () => wakeImpl.stop(),
  pause: () => wakeImpl.pause(),
  resume: () => wakeImpl.resume(),
  get state() {
    return wakeImpl.state
  }
}
ipcMain.on('wake:pcm', (e, samples) => {
  if (e.sender === win?.webContents && samples instanceof Float32Array) wakeKws.pcm(samples)
})
ipcMain.on('wake:mic', (e, ev) => {
  if (e.sender === win?.webContents) wakeKws.mic(ev)
})
function maybeResumeWake() {
  clearTimeout(wakeResume)
  wakeResume = setTimeout(() => {
    if (!micOpen && !speaking) wake.resume() // resuming a recogniser that is not paused (or not running) does nothing
  }, 1200)
}
function syncWake() {
  if (settings.wakeWord) wake.start()
  else wake.stop()
}
ipcMain.handle('wake:state', (e) => (e.sender === win?.webContents ? { state: wake.state } : null))
ipcMain.on('voice:listening', (e, on) => {
  if (e.sender !== win?.webContents) return
  micOpen = !!on
  if (on) wake.pause()
  else maybeResumeWake()
  if (on) {
    speech.stop() // so he does not hear himself
    speech.warm() // and the answer will start instantly
  }
})
speech.setOnStart((tag) => win?.webContents.send('speech:start', tag))
speech.setOnIdle(() => win?.webContents.send('speech:idle'))
speech.setOnBusy((busy) => {
  speaking = busy
  if (busy) wake.pause()
  else maybeResumeWake()
})
ipcMain.on('speak', (e, text, opts) => {
  if (e.sender !== win?.webContents) return
  const o = opts && typeof opts === 'object' ? opts : {}
  void speech.speak(typeof text === 'string' ? text : '', {
    queue: o.queue === true,
    urgent: o.urgent === true,
    tag: typeof o.tag === 'string' ? o.tag.slice(0, 140) : undefined
  })
})
ipcMain.on('tts:event', (e, ev) => {
  if (e.sender === win?.webContents) speech.played(ev)
})
ipcMain.on('speak:stop', (e) => {
  if (e.sender === win?.webContents) speech.stop()
})

/** switch the voice (name, 'zira', 'male', 'next', 'auto' …) and say one line in it so you can hear the change */
async function pickVoice(pick) {
  if (!speechVoices.length) speechVoices = await speech.listVoices()
  const v = speech.resolveVoice(pick, settings.voiceName)
  if (!v) return null
  update({ voiceName: v.name })
  speech.setVoice(v.name)
  void speech.speak(`Hello, this is ${v.name ? v.short : 'my default voice'}. How do I sound?`)
  return { name: v.name, short: v.short || 'automatic', gender: v.gender || '' }
}
ipcMain.handle('voice:pick', (e, pick) => (e.sender === win?.webContents ? pickVoice(String(pick || 'next')) : null))
ipcMain.handle('voice:list', async (e) => {
  if (e.sender !== win?.webContents) return []
  if (!speechVoices.length) speechVoices = await speech.listVoices()
  return speechVoices.map((v) => ({ name: v.name, short: v.short, gender: v.gender, active: v.name === settings.voiceName }))
})

// ---------------------------------------------------------------- updates
ipcMain.handle('update:state', (e) => (e.sender === win?.webContents ? { ...updater.state, version_now: app.getVersion() } : null))
ipcMain.handle('update:check', async (e) => (e.sender === win?.webContents ? { ...(await updater.check()), version_now: app.getVersion() } : null))
ipcMain.on('update:install', (e) => {
  if (e.sender === win?.webContents) updater.install()
})

// ---------------------------------------------------------------- lifecycle
// tests can replace the microphone with a fake device that plays a WAV file once (never in a normal run)
if (process.env.SPIDEY_TEST) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  if (process.env.SPIDEY_FAKE_MIC_WAV) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.SPIDEY_FAKE_MIC_WAV + '%noloop')
  app.setPath('userData', path.join(app.getPath('temp'), 'jarvis-test-' + process.pid)) // fresh profile per test run
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)
    audioModels.setUserDir(app.getPath('userData'))
    loadSettings()
    createWindow()
    buildTray()
    syncLoginItem(settings.startup)
    updater.on('state', (s) => {
      buildTray()
      win?.webContents.send('update:state', s)
      if (s.state === 'ready' && Notification.isSupported()) {
        const n = new Notification({ title: 'Jarvis update ready', body: `Version ${s.version} is downloaded. Click to restart and update.`, silent: true })
        n.on('click', () => updater.install())
        n.show()
      }
    })
    updater.start()
    speech.setVoice(settings.voiceName)
    audio.onCrash((code) => console.error('audio worker crashed, exit', code))
    initBrain()
    const ours = (url) => typeof url === 'string' && url.startsWith('file://')
    const allowed = (permission, details) => permission === 'media' && (!details || !details.mediaTypes || details.mediaTypes.every((t) => t === 'audio'))
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(ours(wc.getURL()) && allowed(permission, details)))
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => (wc ? ours(wc.getURL()) : ours(origin)) && allowed(permission, details))
    void speech.listVoices().then((v) => {
      speechVoices = v
      buildTray()
    })
    if (!settings.trayHinted && Notification.isSupported() && !process.env.SPIDEY_TEST) {
      settings.trayHinted = true
      saveSettings()
      setTimeout(() => {
        new Notification({ title: 'Jarvis is running', body: 'Press Ctrl+Alt+Space to talk, Ctrl+Alt+J to open. The tray icon by the clock may be under the ^ arrow.', silent: true }).show()
      }, 6000)
    }
    stopInbox = notifications.start({
      selfIds: [APP_ID],
      emit: (items) => {
        if (settings.inbox) win?.webContents.send('inbox', items)
      }
    })
    globalShortcut.register('Control+Alt+J', showWindow)
    globalShortcut.register('Control+Alt+Space', () => win?.webContents.send('voice:toggle'))
  })
  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    stopInbox?.()
    updater.dispose()
    speech.stop()
    wake.stop()
    audio.stop()
    quitting = true
  })
  app.on('window-all-closed', () => {
    /* tray keeps the app alive */
  })
}
