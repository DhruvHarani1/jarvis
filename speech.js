'use strict'
/**
 * Jarvis's voice. Chromium inside Electron exposes no speech voices, so the browser speech API stays silent;
 * instead we use the speech engine Windows already ships (System.Speech / SAPI voices such as Zira and David).
 *
 * One long-lived PowerShell "speaker" process is kept while Jarvis is in use (it is shut down after a minute of
 * silence, so it costs no RAM when idle). Sentences are sent to it one line at a time as base64 on stdin, never in a
 * command line, so nothing a reply contains can be run as code. Because it uses SpeakAsync it can be cancelled instantly.
 *
 * speak(text)                    interrupts whatever is playing and speaks now
 * speak(text, {queue: true})     waits its turn (notifications, streamed sentences); the queue is short, oldest dropped
 * speak(text, {urgent: true, queue: true})   jumps the queue and cuts the current sentence (a ringing call)
 * stop()                         silence + clear the queue
 */
const { spawn: realSpawn } = require('node:child_process')

// Protocol (one line each way):  V <voice>  select voice | C  cancel the current sentence | S <base64>  speak
//                                 READY  engine is up   | DONE  finished (or cancelled) the sentence
const ENGINE_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.Rate = 1; $s.Volume = 90',
  "function Pick($want) { $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en*' }; $p = $null; if ($want) { $p = $v | Where-Object { $_.VoiceInfo.Name -eq $want } | Select-Object -First 1 }; if (-not $p) { $p = $v | Where-Object { $_.VoiceInfo.Name -match 'Zira|Aria|Jenny' } | Select-Object -First 1 }; if (-not $p) { $p = $v | Select-Object -First 1 }; if ($p) { $s.SelectVoice($p.VoiceInfo.Name) } }",
  'Pick $env:SPIDEY_VOICE',
  '$in = [Console]::OpenStandardInput(); $buf = New-Object byte[] 8192; $sb = New-Object System.Text.StringBuilder; $task = $in.ReadAsync($buf, 0, $buf.Length)',
  'function Pump { if ($task.IsCompleted) { $n = $task.Result; if ($n -le 0) { exit }; [void]$sb.Append([Text.Encoding]::ASCII.GetString($buf, 0, $n)); $script:task = $in.ReadAsync($buf, 0, $buf.Length) } }',
  'function NextLine { Pump; $t = $sb.ToString(); $i = $t.IndexOf([char]10); if ($i -lt 0) { return $null }; [void]$sb.Remove(0, $i + 1); return $t.Substring(0, $i).Trim() }',
  "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()",
  'while ($true) {',
  '  $line = NextLine',
  '  if ($null -eq $line) { Start-Sleep -Milliseconds 12; continue }',
  "  if ($line.StartsWith('V ')) { Pick $line.Substring(2).Trim(); continue }",
  "  if ($line -eq 'C') { continue }",
  "  if ($line.StartsWith('S ')) {",
  '    $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(2)))',
  '    $p = $s.SpeakAsync($t)',
  '    while (-not $p.IsCompleted) { $l2 = NextLine; if ($l2 -eq "C") { $s.SpeakAsyncCancelAll() } elseif ($null -eq $l2) { Start-Sleep -Milliseconds 12 } }',
  "    [Console]::Out.WriteLine('DONE'); [Console]::Out.Flush()",
  '  }',
  '}'
].join('\n')

const LIST_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { '{0}|{1}|{2}' -f $_.VoiceInfo.Name, $_.VoiceInfo.Gender, $_.VoiceInfo.Culture.Name }"
].join('; ')

const MAX_CHARS = 420
const MAX_QUEUE = 10
const IDLE_SHUTDOWN_MS = 60_000
const READY_TIMEOUT_MS = 20_000

let voice = '' // '' = automatic (a friendly female English voice if there is one)
let voices = null // [{name, gender, culture, short}], filled by listVoices()

/** "Microsoft Zira Desktop" -> "Zira" */
const shortName = (full) => String(full).replace(/^Microsoft\s+/i, '').replace(/\s+(Desktop|Mobile|Online).*$/i, '').trim()

function setVoice(name) {
  voice = /^[\w .()-]{1,80}$/.test(String(name || '')) ? String(name) : ''
}
const getVoice = () => voice

let spawnFn = realSpawn
/** tests inject a fake spawn */
function _setSpawn(fn) {
  spawnFn = fn || realSpawn
}

/** installed English voices (cached after the first call) */
function listVoices() {
  if (voices) return Promise.resolve(voices)
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LIST_SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return resolve([])
    }
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => resolve([]))
    child.on('close', () => {
      voices = out
        .split(/\r?\n/)
        .map((l) => l.trim().split('|'))
        .filter((p) => p.length === 3 && /^en/i.test(p[2]))
        .map(([name, gender, culture]) => ({ name, gender: gender.toLowerCase(), culture, short: shortName(name) }))
      resolve(voices)
    })
  })
}

/** "zira" | "david" | "male" | "female" | "next" | "auto" -> an installed voice (or null) */
function resolveVoice(pick, current = voice) {
  const list = voices || []
  const p = String(pick || '').toLowerCase().trim()
  if (!list.length) return null
  if (p === 'auto' || p === 'default') return { name: '', short: 'automatic' }
  if (p === 'next' || p === 'other' || p === 'switch') {
    const i = list.findIndex((v) => v.name === current)
    return list[(i + 1) % list.length]
  }
  if (p === 'male' || p === 'female') return list.find((v) => v.gender === p) || null
  return list.find((v) => v.name.toLowerCase() === p || v.short.toLowerCase() === p || v.name.toLowerCase().includes(p)) || null
}

/** plain lower-case text, no control characters, bounded length */
function clean(text) {
  // eslint-disable-next-line no-control-regex
  const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const lower = t.toLowerCase()
  return lower.length > MAX_CHARS ? lower.slice(0, MAX_CHARS) : lower
}

// ------------------------------------------------------------------ the engine process
let eng = null // {child, buf, ready, waiting, voiceSent}
let queue = [] // [{text, tag, resolve}]
let busy = false
let onStart = null
let onIdle = null
let onBusy = null
let idleTimer = null

/** main.js: be told when an item starts playing (so the caption can show what is being read) */
function setOnStart(fn) {
  onStart = fn
}
/** main.js: be told when she starts / stops talking (the wake word pauses while she speaks) */
function setOnBusy(fn) {
  onBusy = fn
}
/** main.js: be told when everything queued has been spoken (conversation mode listens again here) */
function setOnIdle(fn) {
  onIdle = fn
}

function killEngine() {
  clearTimeout(idleTimer)
  if (eng) {
    const e = eng
    eng = null
    try {
      e.child.kill()
    } catch {
      /* already gone */
    }
    if (e.waiting) e.waiting('killed')
  }
}

function touchIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!busy && !queue.length) killEngine()
  }, IDLE_SHUTDOWN_MS)
  if (idleTimer.unref) idleTimer.unref()
}

function startEngine() {
  const child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ENGINE_SCRIPT], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, SPIDEY_VOICE: voice }
  })
  const e = { child, buf: '', waiting: null, voiceSent: voice, ready: null }
  e.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the speech engine did not start')), READY_TIMEOUT_MS)
    e.markReady = () => {
      clearTimeout(t)
      resolve()
    }
    child.on('error', (err) => {
      clearTimeout(t)
      reject(err)
    })
    child.on('close', () => {
      clearTimeout(t)
      reject(new Error('the speech engine stopped'))
      if (eng === e) eng = null
      if (e.waiting) e.waiting('closed')
    })
  })
  e.ready.catch(() => {})
  child.stdout.on('data', (d) => {
    e.buf += d
    let i
    while ((i = e.buf.indexOf('\n')) >= 0) {
      const line = e.buf.slice(0, i).trim()
      e.buf = e.buf.slice(i + 1)
      if (line === 'READY') e.markReady()
      else if (line === 'DONE' && e.waiting) {
        const w = e.waiting
        e.waiting = null
        w('done')
      }
    }
  })
  child.stdin.on('error', () => {})
  eng = e
  return e
}

const send = (e, line) => {
  try {
    e.child.stdin.write(line + '\n')
  } catch {
    /* engine closing */
  }
}

/** start the engine in the background so the first sentence is instant (the mic button does this) */
function warm() {
  if (process.env.SPIDEY_TEST && process.env.SPIDEY_SPEECH_LOG) return
  if (!eng) {
    try {
      startEngine()
    } catch {
      /* will retry on demand */
    }
  }
  touchIdle()
}

/** cancel what is being said right now (the queue is untouched) */
function cancelCurrent() {
  if (eng && eng.waiting) {
    const e = eng
    const w = e.waiting
    send(e, 'C')
    // belt and braces: if the engine does not acknowledge THIS cancel, kill it so we never hang
    // (it must be the same pending sentence, or a newer sentence would be killed by a stale timer)
    setTimeout(() => {
      if (eng === e && e.waiting === w) killEngine()
    }, 1500).unref?.()
  }
}

function stop() {
  const dropped = queue
  queue = []
  cancelCurrent()
  for (const q of dropped) q.resolve({ ok: true, ms: 0, skipped: true })
}

async function run(item) {
  const t0 = Date.now()
  // test harness only: write what WOULD be spoken to a file instead of making sound
  if (process.env.SPIDEY_TEST && process.env.SPIDEY_SPEECH_LOG) {
    try {
      require('node:fs').appendFileSync(process.env.SPIDEY_SPEECH_LOG, JSON.stringify({ text: item.text, voice, tag: item.tag || null }) + '\n')
    } catch {
      /* ignore */
    }
    if (onStart && item.tag) onStart(item.tag)
    await new Promise((r) => setTimeout(r, 150))
    item.resolve({ ok: true, ms: 150 })
    return
  }
  let e
  try {
    e = eng || startEngine()
    await e.ready
  } catch (err) {
    killEngine()
    item.resolve({ ok: false, ms: Date.now() - t0, error: err.message })
    return
  }
  if (e.voiceSent !== voice) {
    send(e, `V ${voice}`)
    e.voiceSent = voice
  }
  if (onStart && item.tag) onStart(item.tag)
  await new Promise((resolve) => {
    e.waiting = resolve
    send(e, `S ${Buffer.from(item.text, 'utf8').toString('base64')}`)
  })
  item.resolve({ ok: true, ms: Date.now() - t0 })
  touchIdle()
}

async function pump() {
  if (busy) return
  busy = true
  if (onBusy) onBusy(true)
  while (queue.length) await run(queue.shift())
  busy = false
  if (onBusy) onBusy(false)
  if (onIdle) onIdle()
}

/**
 * @param {string} text
 * @param {{queue?:boolean, urgent?:boolean, tag?:string}} [opts]
 * @returns {Promise<{ok:boolean, ms:number, skipped?:boolean, error?:string}>} resolves when this item has finished (or was dropped)
 */
function speak(text, opts = {}) {
  const t = clean(text)
  if (!opts.queue && !opts.urgent) stop() // plain speak() = interrupt everything and talk now
  if (!t) return Promise.resolve({ ok: true, ms: 0 })
  return new Promise((resolve) => {
    const item = { text: t, tag: opts.tag, resolve }
    if (opts.urgent) {
      queue.unshift(item)
      cancelCurrent() // an urgent item also cuts off the sentence in progress, so a ringing call is not announced late
    } else queue.push(item)
    while (queue.length > MAX_QUEUE) queue.shift().resolve({ ok: true, ms: 0, skipped: true })
    void pump()
  })
}

module.exports = {
  speak, stop, warm, clean, setOnStart, setOnIdle, setOnBusy, setVoice, getVoice, listVoices, resolveVoice, shortName,
  _setSpawn, _setVoices: (v) => (voices = v), _kill: killEngine, _busy: () => busy,
  SCRIPT: ENGINE_SCRIPT, MAX_CHARS, MAX_QUEUE
}
