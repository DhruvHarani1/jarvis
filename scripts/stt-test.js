'use strict'
// Unit tests for speech-to-text routing (fake PowerShell: nothing is recognised for real here).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const stt = require('../stt')
const V = require('../renderer/voice-core.js')

const wav = Buffer.from(V.encodeWav(new Float32Array(16000).fill(0.1)))

// ---- sanity checks on audio
assert.equal(stt.looksLikeWav(wav), true)
assert.equal(stt.looksLikeWav(Buffer.from('hello world, this is not audio at all, no way, no how, not even close')), false)
assert.equal(stt.looksLikeWav(Buffer.alloc(10)), false)
assert.equal(stt.looksLikeWav(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(stt.MAX_WAV_BYTES)])), false, 'huge audio is refused')
assert.equal(stt.looksLikeWav('RIFF....WAVE'), false)

// ---- the command grammar
{
  const p = stt.buildPhrases({})
  assert.ok(p.length > 20 && p.length <= 220, 'phrases: ' + p.length)
  for (const must of ['what did i miss', 'repeat that', 'hey jarvis', 'change voice', 'read my notifications', 'new chat']) assert.ok(p.includes(must), 'grammar should include "' + must + '"')
  assert.ok(p.every((x) => /^[a-z' ]+$/.test(x)), 'only plain words reach the grammar')
  assert.ok(!p.some((x) => /kill|chrome|digit/.test(x)), 'app-specific / dangerous phrases are not in the grammar')
  assert.equal(new Set(p).size, p.length, 'no duplicates')
  assert.ok(stt.NUMBER_WORDS.includes('twenty five') && stt.NUMBER_WORDS.includes('half an') && stt.NUMBER_WORDS.includes('sixty'))
}

// ---- the recognizer script reads everything from environment variables (nothing is spliced into the command)
assert.ok(!/\$\{|`/.test(stt.WIN_SCRIPT))
assert.match(stt.WIN_SCRIPT, /SetInputToWaveFile\(\$env:SPIDEY_WAV\)/)
assert.match(stt.WIN_SCRIPT, /DictationGrammar/)
assert.ok(!/while \(\$true\)/.test(stt.WIN_SCRIPT), 'must never loop: a file recognizer would replay the same phrase forever')

/** fake powershell recognizer: prints `reply` and records what it was given */
function fakeRecognizer(reply, { fail = false } = {}) {
  const seen = { env: null, fileExisted: false, fileBytes: 0 }
  const fn = (_cmd, _args, opts) => {
    seen.env = opts.env
    seen.fileExisted = fs.existsSync(opts.env.SPIDEY_WAV)
    seen.fileBytes = seen.fileExisted ? fs.statSync(opts.env.SPIDEY_WAV).size : 0
    seen.file = opts.env.SPIDEY_WAV
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => child.emit('close', 1)
    setTimeout(() => {
      if (fail) child.emit('error', new Error('powershell missing'))
      else {
        child.stdout.emit('data', reply + '\r\n')
        child.emit('close', 0)
      }
    }, 5)
    return child
  }
  return { fn, seen }
}
const brainOk = (text) => ({ canTranscribe: () => true, transcribe: async () => ({ ok: true, text, via: 'my groq', chain: ['my groq: ok'] }) })
const brainDown = () => ({ canTranscribe: () => true, transcribe: async () => ({ ok: false, chain: ['my groq: rate limit reached'], error: 'every Groq key failed' }) })
const noKey = { canTranscribe: () => false, transcribe: async () => assert.fail('must not be called without a key') }

;(async () => {
  // auto + a working Groq key: cloud answer, Windows never touched
  {
    const { fn, seen } = fakeRecognizer('should not be used')
    stt._setSpawn(fn)
    const r = await stt.transcribe(wav, { brain: brainOk('what is my cpu'), mode: 'auto' })
    assert.deepEqual({ ok: r.ok, text: r.text, via: r.via }, { ok: true, text: 'what is my cpu', via: 'Groq Whisper (my groq)' })
    assert.equal(seen.env, null, 'the audio did not touch Windows at all')
  }
  // auto, Groq failing: falls back to Windows and says so
  {
    const { fn, seen } = fakeRecognizer('start the focus timer')
    stt._setSpawn(fn)
    const r = await stt.transcribe(wav, { brain: brainDown(), mode: 'auto', phrases: ['start focus', 'stop'] })
    assert.equal(r.ok, true)
    assert.equal(r.text, 'start the focus timer')
    assert.equal(r.via, 'Windows (offline)')
    assert.deepEqual(r.chain, ['my groq: rate limit reached', 'Windows: ok'])
    assert.equal(seen.fileExisted, true, 'Windows got a real WAV file')
    assert.equal(seen.fileBytes, wav.length)
    assert.deepEqual(JSON.parse(Buffer.from(seen.env.SPIDEY_PHRASES, 'base64').toString()), ['start focus', 'stop'], 'phrases travel as base64 JSON in the environment')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(fs.existsSync(seen.file), false, 'the temporary recording is deleted straight away')
  }
  // offline mode: the cloud is never asked, whatever keys exist
  {
    const { fn } = fakeRecognizer('hey karen')
    stt._setSpawn(fn)
    const r = await stt.transcribe(wav, { brain: { canTranscribe: () => true, transcribe: async () => assert.fail('offline mode must not call the cloud') }, mode: 'offline' })
    assert.equal(r.text, 'hey karen')
    assert.equal(r.via, 'Windows (offline)')
  }
  // no Groq key at all: straight to Windows
  {
    const { fn } = fakeRecognizer('take a break')
    stt._setSpawn(fn)
    const r = await stt.transcribe(wav, { brain: noKey, mode: 'auto' })
    assert.equal(r.text, 'take a break')
  }
  // silence / noise: ok with empty text (not an error)
  {
    const { fn } = fakeRecognizer('')
    stt._setSpawn(fn)
    const r = await stt.transcribe(wav, { mode: 'offline' })
    assert.deepEqual({ ok: r.ok, text: r.text }, { ok: true, text: '' })
  }
  // the strict command grammar hears nothing: one more try with free dictation
  {
    const replies = ['', 'what is my cpu']
    const seenPhrases = []
    stt._setSpawn((c, a2, opts) => {
      seenPhrases.push(opts.env.SPIDEY_PHRASES)
      return fakeRecognizer(replies.shift()).fn(c, a2, opts)
    })
    const r = await stt.transcribe(wav, { mode: 'offline', phrases: ['start focus'] })
    assert.equal(r.text, 'what is my cpu')
    assert.equal(seenPhrases.length, 2)
    assert.ok(seenPhrases[0] !== '' && seenPhrases[1] === '', 'the retry runs without the command grammar')
  }
  // silence stays silence (one call when there was no grammar to relax)
  {
    let calls = 0
    stt._setSpawn((c, a2, opts) => {
      calls++
      return fakeRecognizer('').fn(c, a2, opts)
    })
    const r = await stt.transcribe(wav, { mode: 'offline' })
    assert.deepEqual({ ok: r.ok, text: r.text, calls }, { ok: true, text: '', calls: 1 })
  }
  // PowerShell cannot start: a clear error, and the temp file is still cleaned up
  {
    const { fn, seen } = fakeRecognizer('', { fail: true })
    stt._setSpawn(fn)
    const r = await stt.transcribe(wav, { mode: 'offline' })
    assert.equal(r.ok, false)
    assert.match(r.error, /powershell missing/)
    await new Promise((r2) => setTimeout(r2, 30))
    assert.equal(fs.existsSync(seen.file), false)
  }
  // not audio: refused before anything runs
  {
    stt._setSpawn(() => assert.fail('must not start a recognizer for junk'))
    const r = await stt.transcribe(Buffer.from('junk junk junk junk junk junk junk junk junk junk junk junk junk'), { mode: 'auto' })
    assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'not a valid recording' })
  }
  stt._setSpawn(null)
  console.log('stt: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
