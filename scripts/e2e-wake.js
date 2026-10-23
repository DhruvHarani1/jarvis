'use strict'
// End-to-end check of the on-PC wake word in the real app: the fake microphone plays a spoken "Hey Jarvis" (made with the
// Piper voice), the keyword spotter in the audio worker must hear it and open the listening state. Also checks that
// plain speech does NOT wake it. Needs the voice and wake models.
//   node scripts/e2e-wake.js
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const models = require('../audio/models')
const engine = require('../audio/engine')
const pcm = require('../audio/pcm')

async function connect(match, port) {
  for (let i = 0; i < 80; i++) {
    try {
      const pg = (await (await fetch(`http://localhost:${port}/json`)).json()).find((p) => p.url.includes(match))
      if (pg) {
        const ws = new WebSocket(pg.webSocketDebuggerUrl)
        await new Promise((r) => (ws.onopen = r))
        let id = 0
        const pend = new Map()
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data)
          if (d.id && pend.has(d.id)) pend.get(d.id)(d)
        }
        return {
          ev: async (e) =>
            (await new Promise((r) => {
              pend.set(++id, r)
              ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } }))
            })).result.result.value
        }
      }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('no page ' + match)
}

/** speak a phrase with Piper and wrap it as the fake microphone recording */
function makeMic(sherpa, phrase, name) {
  const e = engine.create({ sherpa, models, requirePhonemizer: (d) => require(d) })
  const t = e.synth(phrase)
  const src = path.join(root, 'scratch', name + '-src.wav')
  sherpa.writeWave(src, { samples: t.samples, sampleRate: t.rate })
  const out = path.join(root, 'scratch', name + '.wav')
  const r = spawnSync(process.execPath, [path.join(__dirname, 'make-fake-mic.js'), src, out])
  if (r.status !== 0) throw new Error('could not build ' + name)
  return out
}

async function run(micWav, port, expectWake) {
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const app = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_KWS: '1', SPIDEY_SPEECH_LOG: path.join(require('node:os').tmpdir(), 'jarvis-e2e-wake-speech.log'), SPIDEY_FAKE_MIC_WAV: micWav }
  })
  try {
    const w = await connect('index.html', port)
    for (let i = 0; i < 40 && !(await w.ev('!!window.Assistant && !!window.Voice')); i++) await sleep(500)
    await w.ev('window.__ws = []; window.jarvis.onWakeState((x) => window.__ws.push(x.state + (x.detail ? ":" + x.detail : "")))')
    await w.ev('window.Assistant.command("turn on the wake word")')
    let listening = false
    for (let i = 0; i < (expectWake ? 80 : 40) && !listening; i++) {
      listening = (await w.ev('document.body.dataset.listening')) === '1'
      await sleep(250)
    }
    return { listening, states: await w.ev('window.__ws') }
  } finally {
    app.kill()
  }
}

;(async () => {
  if (!models.ready('voice') || !models.ready('wake')) {
    console.log('wake e2e SKIPPED (models not installed)')
    process.exit(0)
  }
  const sherpa = require('sherpa-onnx-node')
  let fails = 0
  const ok = (name, cond, extra = '') => {
    if (!cond) fails++
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
  }
  const hey = makeMic(sherpa, 'Hey Jarvis, what is the weather like today?', 'mic-hey-jarvis')
  const r1 = await run(hey, 9336, true)
  ok('spoken "Hey Jarvis" wakes the on-PC keyword spotter', r1.listening, JSON.stringify(r1.states))
  const plain = makeMic(sherpa, 'What is the weather like today? I think it will be sunny in the afternoon.', 'mic-plain')
  const r2 = await run(plain, 9337, false)
  ok('ordinary speech does not wake it', !r2.listening, JSON.stringify(r2.states))
  console.log(fails ? `wake e2e: ${fails} FAILED` : 'wake e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
