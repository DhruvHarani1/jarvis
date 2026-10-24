'use strict'
// Unit tests for audio/models.js, audio/engine.js, audio/client.js (no microphone, no network). If the real models are
// installed (models-dev/), a round-trip test also runs: Piper speaks a sentence, Moonshine must hear the same words.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const models = require('../audio/models')
const engine = require('../audio/engine')
const client = require('../audio/client')
const pcm = require('../audio/pcm')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-audio-test-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

;(async () => {
  // ---------------------------------------------------------------- models: unsafe paths are recognised
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', 'C:/x', 'a\\..\\b']) assert.equal(models.unsafeEntry(bad), true, bad)
  for (const ok of ['folder/', 'folder/file.onnx', 'a/b/c.txt']) assert.equal(models.unsafeEntry(ok), false, ok)

  // ---------------------------------------------------------------- models: manifest is complete and pinned
  for (const [id, m] of Object.entries(models.MANIFEST)) {
    assert.ok(m.url.startsWith('https://'), id + ' uses https')
    assert.ok(m.sha256 ? /^[0-9a-f]{64}$/.test(m.sha256) : /^sha512-/.test(m.integrity), id + ' has a pinned checksum')
    assert.ok(m.bytes > 0 && m.dir && m.license, id)
  }
  for (const [b, ids] of Object.entries(models.BUNDLES)) for (const id of ids) assert.ok(models.MANIFEST[id], `${b} -> ${id}`)

  // ---------------------------------------------------------------- models: verify catches a wrong file
  {
    const f = path.join(tmp, 'blob')
    fs.writeFileSync(f, 'hello')
    const good = crypto.createHash('sha256').update('hello').digest('hex')
    await models.verify(f, { sha256: good })
    await assert.rejects(models.verify(f, { sha256: '0'.repeat(64) }), /checksum mismatch/)
    const integ = 'sha512-' + crypto.createHash('sha512').update('hello').digest('base64')
    await models.verify(f, { integrity: integ })
    await assert.rejects(models.verify(f, { integrity: 'sha512-AAAA' }), /checksum mismatch/)
    await assert.rejects(models.verify(f, {}), /no checksum/)
  }

  // ---------------------------------------------------------------- models: install end to end with a fake download of a real tar
  {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(path.join(src, 'fake-model'), { recursive: true })
    fs.writeFileSync(path.join(src, 'fake-model', 'a.txt'), 'data')
    const archive = path.join(tmp, 'fake.tar')
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    const have = fs.existsSync(tar) ? tar : 'tar'
    assert.equal(spawnSync(have, ['-cf', archive, '-C', src, 'fake-model']).status, 0, 'test archive created')
    const sha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    const saved = { ...models.MANIFEST.wake }
    Object.assign(models.MANIFEST.wake, { url: 'https://example.invalid/x.tar', sha256: sha, dir: 'fake-model', bytes: 10 })
    const root = path.join(tmp, 'models-root')
    fs.mkdirSync(root)
    process.env.JARVIS_MODELS_DIR = root
    const progress = []
    const dest = await models.install('wake', (p) => progress.push(p), {
      tar: have,
      download: async (url, file, cb) => {
        assert.equal(url, 'https://example.invalid/x.tar')
        fs.copyFileSync(archive, file)
        cb(5, 10)
      }
    })
    assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'data')
    assert.equal(models.locate('wake'), dest)
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.staging')), [], 'no staging folder left')
    assert.equal(progress[0].got, 5)
    // a corrupt download is refused and leaves nothing behind
    fs.rmSync(dest, { recursive: true })
    await assert.rejects(models.install('wake', () => {}, { tar: have, download: async (u, file) => fs.writeFileSync(file, 'garbage') }), /checksum mismatch/)
    assert.equal(fs.existsSync(dest), false)
    Object.assign(models.MANIFEST.wake, saved)
    delete process.env.JARVIS_MODELS_DIR
  }

  // ---------------------------------------------------------------- pcm helpers
  {
    const R = 16000
    const clip = new Float32Array(R * 5)
    for (let i = 0; i < clip.length; i++) clip[i] = (Math.random() - 0.5) * 0.004 // room noise
    for (let i = R * 2; i < R * 3; i++) clip[i] = Math.sin(i / 9) * 0.3 // "speech" from 2.0 s to 3.0 s
    const cut = pcm.trimSilence(clip, R)
    assert.ok(cut.length >= R && cut.length < R * 2, `kept the speech plus padding, dropped the rest (kept ${(cut.length / R).toFixed(2)} s)`)
    const quiet = new Float32Array(R).fill(0.001)
    assert.equal(pcm.trimSilence(quiet, R), quiet, 'no speech: returned unchanged')
    // wav round trip
    const VC = require('../renderer/voice-core')
    const wav = Buffer.from(VC.encodeWav(Float32Array.of(0, 0.5, -0.5, 1), 16000))
    const back = pcm.wavToFloat32(wav)
    assert.equal(back.rate, 16000)
    assert.ok(Math.abs(back.samples[1] - 0.5) < 0.001 && Math.abs(back.samples[2] + 0.5) < 0.001)
    assert.equal(pcm.wavToFloat32(Buffer.from('nope')), null)
    assert.equal(pcm.resample(Float32Array.of(1, 1, 1, 1), 16000, 8000).length, 2)
  }

  // ---------------------------------------------------------------- engine with a fake sherpa
  {
    const calls = []
    const fakeSherpa = {
      OfflineRecognizer: class {
        createStream() {
          return { acceptWaveform: (w) => calls.push(['accept', w.samples.length]) }
        }
        decode() {
          calls.push(['decode'])
        }
        getResult() {
          return { text: '  hello jarvis ' }
        }
      },
      OfflineTts: class {
        constructor() {
          this.lang = 'en-gb'
          this.sampleRate = 22050
        }
        generate(o) {
          calls.push(['generate', o.generationConfig.phonemeCodepoints.length])
          return { samples: new Float32Array(2205), sampleRate: 22050 }
        }
      },
      GenerationConfig: class {
        constructor(o) {
          Object.assign(this, o)
        }
      },
      KeywordSpotter: class {
        constructor() {
          this.ready = 0
          this.said = ''
        }
        createStream() {
          const k = this
          return { acceptWaveform: (w) => ((k.ready = 1), (k.said = w.samples[0] === 1 ? 'HEY_JARVIS' : '')) }
        }
        isReady() {
          const r = this.ready
          this.ready = 0
          return r === 1
        }
        decode() {}
        getResult() {
          return { keyword: this.said }
        }
      }
    }
    const voiceDir = path.join(tmp, 'voice')
    fs.mkdirSync(voiceDir)
    fs.writeFileSync(path.join(voiceDir, 'v.onnx'), '')
    const fakeModels = { locate: (id) => ({ stt: tmp, voice: voiceDir, phonemizer: tmp, wake: tmp }[id] || null) }
    const e = engine.create({ sherpa: fakeSherpa, models: fakeModels, requirePhonemizer: () => ({ phonemize: (t) => [[1, 2, 3], [], [4]] }) })
    assert.deepEqual(e.loaded(), { stt: false, tts: false, wake: false }, 'nothing is loaded until used')
    assert.equal(e.transcribe(new Float32Array(16000)).text, 'hello jarvis', 'text is trimmed')
    const s = e.synth('Good afternoon, sir.')
    assert.equal(s.samples.length, 2205)
    assert.deepEqual(calls.find((c) => c[0] === 'generate'), ['generate', 2], 'empty phoneme sentences are dropped')
    assert.equal(e.synth('   ').samples.length, 0, 'blank text makes no sound and loads nothing new')
    assert.equal(e.feedWake(Float32Array.of(0, 0)), '')
    assert.equal(e.feedWake(Float32Array.of(1, 0)), 'HEY_JARVIS')
    assert.deepEqual(e.loaded(), { stt: true, tts: true, wake: true })
    e.unload('tts')
    assert.deepEqual(e.loaded(), { stt: true, tts: false, wake: true })
    e.unload()
    assert.deepEqual(e.loaded(), { stt: false, tts: false, wake: false })
    const none = engine.create({ sherpa: fakeSherpa, models: { locate: () => null }, requirePhonemizer: () => ({}) })
    assert.throws(() => none.transcribe(new Float32Array(10)), /not installed/)
    assert.throws(() => none.synth('hi'), /not installed/)
  }

  // ---------------------------------------------------------------- client with a fake worker process
  {
    const handlers = {}
    let kills = 0
    const timers = []
    const mkChild = (behave) => ({
      on: (ev, cb) => ((handlers[ev] = cb), undefined),
      postMessage: (m) => behave(m),
      kill: () => kills++
    })
    let forks = 0
    const child = mkChild((m) => {
      if (m.op === 'stt') setImmediate(() => handlers.message({ id: m.id, ok: true, text: 'hi', ms: 5 }))
      if (m.op === 'tts') setImmediate(() => handlers.message({ id: m.id, ok: false, error: 'voice model not installed' }))
      if (m.op === 'wake') setImmediate(() => handlers.message({ event: 'wake', keyword: 'HEY_JARVIS' }))
    })
    const c = client.create({
      fork: () => (forks++, child),
      workerPath: 'w.js',
      idleMs: 1000,
      setTimer: (fn, ms) => {
        const t = { fn, ms }
        timers.push(t)
        return t
      },
      clearTimer: (t) => {
        const i = timers.indexOf(t)
        if (i >= 0) timers.splice(i, 1)
      }
    })
    assert.equal(c.running, false)
    assert.equal((await c.transcribe(new Float32Array(4))).text, 'hi')
    assert.equal(forks, 1)
    await assert.rejects(c.speak('x'), /voice model not installed/)
    // idle timer: only the idle timer remains, firing it stops the worker
    const idle = timers.find((t) => t.ms === 1000)
    assert.ok(idle, 'an idle timer is armed')
    idle.fn()
    assert.equal(kills, 1, 'idle worker is killed to free RAM')
    assert.equal(c.running, false)
    // wake word keeps the worker alive and reports detections
    const woke = new Promise((r) => c.onWake(r))
    c.feedWake(new Float32Array(4))
    assert.equal(await woke, 'HEY_JARVIS')
    assert.equal(timers.find((t) => t.ms === 1000), undefined, 'no idle timer while the wake word is listening')
    // a crash fails the request in flight, the next one starts a fresh worker
    const hang = mkChild(() => {})
    let n = 0
    const c2 = client.create({ fork: () => (n++, n === 1 ? hang : child), workerPath: 'w.js', idleMs: 0, setTimer: (fn) => ({ fn }), clearTimer: () => {} })
    const inflight = c2.transcribe(new Float32Array(1))
    handlers.exit(3)
    await assert.rejects(inflight, /stopped/)
    assert.equal((await c2.transcribe(new Float32Array(1))).text, 'hi')
    assert.equal(n, 2)
  }

  // ---------------------------------------------------------------- real models: speak a sentence, hear it back (only when installed)
  const real = models.ready('voice') && models.ready('stt')
  if (!real) console.log('audio: real-model round trip SKIPPED (models not installed)')
  else {
    const e = engine.create({ sherpa: require('sherpa-onnx-node'), models, requirePhonemizer: (dir) => require(dir) })
    const phrase = 'Good afternoon, sir. It is half past three, and you have two meetings today.'
    const t = e.synth(phrase)
    assert.ok(t.samples.length > 22050 * 3, 'a real sentence has seconds of audio')
    if (t.ms / 1000 >= t.samples.length / t.rate) console.log('audio: WARNING voice slower than real time on this machine right now (' + t.ms + ' ms); the app falls back to the Windows voice when that happens')
    assert.ok(t.ms / 1000 < (t.samples.length / t.rate) * 4, 'voice speed is within a sane range')
    // 22.05 kHz -> 16 kHz (linear) for the recogniser
    const ratio = t.rate / 16000
    const out = new Float32Array(Math.floor(t.samples.length / ratio))
    for (let i = 0; i < out.length; i++) {
      const p = i * ratio
      const a = Math.floor(p)
      out[i] = t.samples[a] + ((t.samples[a + 1] || 0) - t.samples[a]) * (p - a)
    }
    const heard = e.transcribe(out).text.toLowerCase().replace(/[^a-z ]/g, '')
    for (const w of ['good afternoon', 'half past three', 'two meetings']) assert.ok(heard.includes(w), `heard "${heard}" should contain "${w}"`)
    if (models.ready('wake')) {
      const hey = e.synth('Hey Jarvis, what is the time?')
      const o2 = new Float32Array(Math.floor(hey.samples.length / ratio) + 8000)
      for (let i = 0; i < o2.length - 8000; i++) o2[i] = hey.samples[Math.floor(i * ratio)]
      let hit = ''
      for (let i = 0; i < o2.length; i += 1600) hit = hit || e.feedWake(o2.subarray(i, i + 1600))
      assert.ok(/JARVIS/.test(hit), 'wake word heard in spoken "Hey Jarvis" (got ' + hit + ')')
    }
  }

  console.log('audio: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
