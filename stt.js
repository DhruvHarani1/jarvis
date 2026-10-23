'use strict'
/**
 * Speech to text for talking to Jarvis.
 *   auto    : a Groq key (Whisper, accurate, fast) if you have one that works, otherwise Windows' own offline recognizer
 *   offline : Windows only. The audio never leaves your PC.
 * Audio arrives as a 16 kHz mono WAV from the widget; it is only ever written to a temporary file for the Windows
 * recognizer, and that file is deleted straight away.
 */
const { spawn: realSpawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_WAV_BYTES = 3 * 1024 * 1024 // ~95 s of 16 kHz audio; the widget stops at 15 s

const WIN_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
  '$dec = { param($v) if ($v) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) | ConvertFrom-Json } }',
  '$phrases = & $dec $env:SPIDEY_PHRASES',
  '$numbers = & $dec $env:SPIDEY_NUMBERS',
  // 1) exactly the phrases Jarvis understands: by far the most accurate way to recognise a command
  'if ($phrases) { $c = New-Object System.Speech.Recognition.Choices; foreach ($p in $phrases) { $c.Add([string]$p) }; $gb = New-Object System.Speech.Recognition.GrammarBuilder; $gb.Append($c); $g = New-Object System.Speech.Recognition.Grammar($gb); $g.Name = "commands"; $e.LoadGrammar($g) }',
  // 2) "remind me in <number> <unit> to <anything>"
  'if ($numbers) { $n = New-Object System.Speech.Recognition.Choices; foreach ($w in $numbers) { $n.Add([string]$w) }; $u = New-Object System.Speech.Recognition.Choices; foreach ($w in @("second","seconds","minute","minutes","hour","hours")) { $u.Add($w) }; $rb = New-Object System.Speech.Recognition.GrammarBuilder; $rb.Append("remind me in"); $rb.Append($n); $rb.Append($u); $rb.Append("to"); $rb.AppendDictation(); $rg = New-Object System.Speech.Recognition.Grammar($rb); $rg.Name = "reminder"; $e.LoadGrammar($rg) }',
  // 3) anything else: free dictation
  '$e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
  '$e.SetInputToWaveFile($env:SPIDEY_WAV)',
  // one utterance per call; asking for "the next one" would just replay the same phrase from a file, so never loop
  '$r = $e.Recognize([TimeSpan]::FromSeconds(6))',
  'if ($r) { [Console]::Out.WriteLine($r.Text) }'
].join('; ')

const NUMBER_WORDS = (() => {
  const ones = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
  const tens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 }
  const out = [...ones, 'a', 'an', 'half an']
  for (const t of Object.keys(tens)) {
    out.push(t)
    if (t !== 'sixty') for (const o of ones.slice(0, 9)) out.push(t + ' ' + o)
  }
  return out
})()

/**
 * The phrases Windows listens for: the few commands Jarvis handles itself (plain words only); everything else is free dictation.
 * @param {{karen:{items:{say:string,try?:string,aka?:string[]}[]}[]}} help
 */
function buildPhrases(help) {
  // how people actually SAY the common commands (the manual lists typed forms such as "cpu?")
  const spoken = [
    'what did i miss', 'repeat that', 'read my notifications', 'stop reading notifications', 'read notifications privately', 'change voice', 'use zira', 'use david',
    'stop talking', 'conversation mode', 'turn on the wake word', 'turn off the wake word', 'open the ai settings', 'api keys', 'check for updates', 'hello', 'good morning', 'how are you', "what's up"
  ]
  const set = new Set([...spoken, 'hey jarvis', 'okay jarvis', 'hello jarvis', 'stop', 'skip', 'next', 'yes', 'no', 'cancel', 'thank you', 'thanks', 'new chat', 'start over'])
  for (const g of help.karen || [])
    for (const it of g.items || [])
      for (const raw of [it.say, it.try, ...(it.aka || [])]) {
        const p = String(raw || '')
          .toLowerCase()
          .replace(/[?!.,"“”]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (p.length >= 3 && p.length <= 60 && /^[a-z' ]+$/.test(p) && !/\b(kill|chrome|youtube|whatsapp|teams|mail|dhruv|boss)\b/.test(p)) set.add(p)
      }
  return [...set].slice(0, 220)
}

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

let spawnFn = realSpawn
const _setSpawn = (fn) => (spawnFn = fn || realSpawn)

/** a quick sanity check so junk is never handed to a recognizer */
function looksLikeWav(buf) {
  return Buffer.isBuffer(buf) && buf.length > 44 && buf.length <= MAX_WAV_BYTES && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
}

/** Windows' built-in offline dictation recognizer */
function winTranscribe(wav, phrases = [], timeoutMs = 20_000) {
  return new Promise((resolve) => {
    if (!looksLikeWav(wav)) return resolve({ ok: false, error: 'not a valid recording' })
    const file = path.join(os.tmpdir(), `spidey-stt-${crypto.randomBytes(6).toString('hex')}.wav`)
    const cleanup = () => fs.rm(file, { force: true }, () => {})
    try {
      fs.writeFileSync(file, wav)
    } catch (e) {
      return resolve({ ok: false, error: e.message })
    }
    let out = ''
    let child
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SPIDEY_WAV: file, SPIDEY_PHRASES: phrases.length ? b64(phrases) : '', SPIDEY_NUMBERS: b64(NUMBER_WORDS) } })
    } catch (e) {
      cleanup()
      return resolve({ ok: false, error: e.message })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      cleanup()
      resolve({ ok: false, error: e.message })
    })
    child.on('close', () => {
      clearTimeout(timer)
      cleanup()
      resolve({ ok: true, text: out.replace(/\s+/g, ' ').trim() })
    })
  })
}

/**
 * @param {Buffer} wav
 * @param {{brain?:{canTranscribe:()=>boolean, transcribe:(b:Buffer)=>Promise<any>}, mode?:'auto'|'offline', local?:(wav:Buffer)=>Promise<{ok:boolean,text?:string,error?:string}>}} o
 * @returns {Promise<{ok:boolean, text:string, via:string, error?:string, chain?:string[]}>}
 */
async function transcribe(wav, o = {}) {
  if (!looksLikeWav(wav)) return { ok: false, text: '', via: '', error: 'not a valid recording' }
  const chain = []
  // 1) the speech model on this PC (Moonshine): private, free and the most accurate offline option
  if (o.local) {
    try {
      const r = await o.local(wav)
      if (r && r.ok && r.text) return { ok: true, text: r.text, via: 'Moonshine (on this PC)', chain: ['local: ok'] }
      chain.push('local: ' + ((r && r.error) || 'heard nothing'))
    } catch (e) {
      chain.push('local: ' + (e && e.message))
    }
  }
  if (o.mode !== 'offline' && o.brain && o.brain.canTranscribe()) {
    const r = await o.brain.transcribe(wav)
    chain.push(...(r.chain || []))
    if (r.ok) return { ok: true, text: r.text, via: `Groq Whisper (${r.via})`, chain }
  }
  let w = await winTranscribe(wav, o.phrases || [])
  // the command grammar is strict: when it hears nothing it can recognise, ask again with free dictation only
  if (w.ok && !w.text && (o.phrases || []).length) w = await winTranscribe(wav, [])
  if (w.ok) return { ok: true, text: w.text, via: 'Windows (offline)', chain: [...chain, 'Windows: ok'] }
  return { ok: false, text: '', via: '', error: w.error || 'could not recognize speech', chain: [...chain, `Windows: ${w.error}`] }
}

module.exports = { transcribe, winTranscribe, looksLikeWav, buildPhrases, NUMBER_WORDS, WIN_SCRIPT, MAX_WAV_BYTES, _setSpawn }
