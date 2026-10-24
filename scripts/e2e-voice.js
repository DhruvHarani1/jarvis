'use strict'
// End-to-end check of the NEW voice path in the real app: fake microphone says "what is the weather like today",
// Moonshine (on this PC) must hear it, a fake AI provider answers, and the natural voice (Piper) must speak the answer
// through the audio worker and the window's player. Needs the models (models-dev/ or the user models folder) and scratch/fake-mic.wav.
//   node scripts/e2e-voice.js
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const REPLY = 'Your processor is calm, sir. Everything looks healthy.'

const server = http.createServer((req, res) => {
  let data = ''
  req.on('data', (c) => (data += c))
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"data":[{"id":"fake-model"}]}')
    }
    const body = JSON.parse(data || '{}')
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { content: REPLY } }] }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let i = 0
    const t = setInterval(() => {
      if (i >= REPLY.length) {
        res.write('data: [DONE]\n\n')
        res.end()
        return clearInterval(t)
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY.slice(i, i + 6) } }] }) + '\n\n')
      i += 6
    }, 10)
  })
})

async function connect(match) {
  for (let i = 0; i < 80; i++) {
    try {
      const pg = (await (await fetch('http://localhost:9335/json')).json()).find((p) => p.url.includes(match))
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

;(async () => {
  const models = require('../audio/models')
  if (!models.ready('stt') || !models.ready('voice')) {
    console.log('voice e2e SKIPPED (models not installed)')
    process.exit(0)
  }
  await new Promise((r) => server.listen(8799, '127.0.0.1', r))
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const app = spawn(electron, ['.', '--remote-debugging-port=9335'], {
    cwd: root,
    stdio: process.env.E2E_VERBOSE ? 'inherit' : 'ignore',
    env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_LOCAL_STT: '1', SPIDEY_FAKE_MIC_WAV: path.join(root, 'scratch', 'fake-mic.wav') }
  })
  let fails = 0
  const ok = (name, cond, extra = '') => {
    if (!cond) fails++
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
  }
  try {
    const w = await connect('index.html')
    for (let i = 0; i < 40 && !(await w.ev('!!window.Assistant && !!window.Voice && !!window.__voice')); i++) await sleep(500)
    await w.ev('window.jarvis.openBrain()')
    const b = await connect('brain.html')
    const add = await b.ev(`window.brainApi.add({provider:'custom',key:'KEY_E2E_1234',label:'fake',baseUrl:'http://127.0.0.1:8799/v1',model:'fake-model'})`)
    ok('fake provider added', add && add.ok === true)

    await w.ev('window.__ev = []; window.jarvis.onSpeechStart((t) => window.__ev.push("start")); window.jarvis.onSpeechIdle(() => window.__ev.push("idle")); window.__plays = 0; window.jarvis.onTtsPlay((m) => { window.__plays++; window.__rate = m.rate; window.__len = m.samples.length })')
    await w.ev('window.__voice.start()')
    let heard = null
    for (let i = 0; i < 120 && !heard; i++) {
      heard = (await w.ev('(window.__voice.diag.find((d) => d.heard) || null)'))
      await sleep(500)
    }
    const b64 = await w.ev('((window.__voice.diag.find((d) => d.lastWavB64) || {}).lastWavB64) || ""')
    if (b64) fs.writeFileSync(path.join(root, 'scratch', 'e2e-last.wav'), Buffer.from(b64, 'base64'))
    ok('the speech model on this PC heard the fake microphone', !!heard && /cpu|weather/i.test(heard.heard || ''), JSON.stringify(heard))
    ok('transcribed on this PC', !!heard && /on this PC/.test(heard.via || ''), heard && heard.via)
    let idle = false
    for (let i = 0; i < 120 && !idle; i++) {
      idle = (await w.ev('window.__ev.includes("idle")')) === true
      await sleep(500)
    }
    const plays = await w.ev('window.__plays')
    ok('the answer was spoken by the natural voice (PCM reached the window)', plays >= 1, `plays=${plays} rate=${await w.ev('window.__rate')} samples=${await w.ev('window.__len')}`)
    ok('speech went idle again after the whole answer (both sentences played)', idle && plays >= 2, JSON.stringify(await w.ev('window.__ev')) + ' plays=' + plays)
  } catch (e) {
    fails++
    console.log('FAIL  exception', e.message)
  }
  app.kill()
  server.close()
  console.log(fails ? `voice e2e: ${fails} FAILED` : 'voice e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
