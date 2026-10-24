'use strict'
// End-to-end smoke test of the real app. Starts Jarvis itself (fake microphone, fake wake WAV, fake AI provider, dry speech log).
//   node scripts/e2e.js            (needs scratch/fake-mic.wav and scratch/wake-wavs: run scripts/make-fixtures.ps1 once)
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOG = path.join(os.tmpdir(), 'jarvis-e2e-speech.log')
fs.rmSync(LOG, { force: true })
const spoken = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

const REPLY = 'Hello there, good to hear from you! Everything is calm on my side. Anything I can do for you?'
const requests = []
const server = http.createServer((req, res) => {
  let data = ''
  req.on('data', (c) => (data += c))
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"data":[{"id":"fake-model"}]}')
    }
    const body = JSON.parse(data || '{}')
    requests.push(body)
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
      const pg = (await (await fetch('http://localhost:9334/json')).json()).find((p) => p.url.includes(match))
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
  await new Promise((r) => server.listen(8799, '127.0.0.1', r))
  const mic = path.join(root, 'scratch', 'fake-mic.wav')
  const wakeWav = path.join(root, 'scratch', 'wake-wavs', 'wake-hey-david.wav')
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const app = spawn(electron, ['.', '--remote-debugging-port=9334'], {
    cwd: root,
    stdio: process.env.E2E_VERBOSE ? 'inherit' : 'ignore',
    env: { ...process.env, SPIDEY_TEST: '1', SPIDEY_SPEECH_LOG: LOG, SPIDEY_FAKE_MIC_WAV: mic, SPIDEY_WAKE_WAV: wakeWav }
  })
  let fails = 0
  const ok = (name, cond, extra = '') => {
    if (!cond) fails++
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
  }
  try {
    const w = await connect('index.html')
    for (let i = 0; i < 40 && !(await w.ev('!!window.Assistant && !!window.Reader && !!window.Inbox && !!window.Voice')); i++) await sleep(500)
    ok('page loaded with Core, Assistant, Voice, Inbox, Reader', await w.ev('!!window.Assistant && !!window.Voice && !!window.Inbox && !!window.Reader'))
    ok('title is Jarvis', (await w.ev('document.title')) === 'Jarvis')

    // no brain yet -> says so, does not crash
    await w.ev('window.Assistant.handle("hello there")')
    ok('without a brain he says how to get one', /API keys/.test(await w.ev('document.getElementById("log").lastChild.textContent')))

    // local commands
    await w.ev('window.Assistant.handle("conversation mode")')
    await sleep(400)
    ok('"conversation mode" is a local command', (await w.ev('window.Core.getSettings().voiceConverse')) === true)
    await w.ev('window.Assistant.handle("conversation mode off")')

    // add a brain (fake provider) through the brain window
    const b = w
    const add = await b.ev(`window.brainApi.add({provider:'custom',key:'KEY_E2E_1234',label:'fake',baseUrl:'http://127.0.0.1:8799/v1',model:'fake-model'})`)
    ok('brain window can add a key', add && add.ok === true, JSON.stringify(add))

    // typed question: streamed answer, spoken sentence by sentence
    await w.ev('window.Assistant.handle("how are you today?")')
    ok('typed question gets the fake reply', (await w.ev('document.getElementById("log").lastChild.textContent')) === REPLY)
    await sleep(600)
    const said = spoken().map((s) => s.text)
    ok('the reply was spoken (jarvisSpeaks default on)', said.some((t) => /hello there/i.test(t)), JSON.stringify(said))
    ok('the prompt says Jarvis and offers no DO: actions', requests.length && /Jarvis/.test(requests.at(-1).messages[0].content) && !/DO:/.test(requests.at(-1).messages[0].content))

    // wake word -> microphone opens
    await sleep(2500) // let the spoken reply finish and the wake word un-pause (a WAV is only heard once)
    await w.ev('window.__ws = []; window.jarvis.onWakeState((x) => window.__ws.push(x.state + (x.detail ? ":" + x.detail : "")))')
    const wakeSay = await w.ev('window.Assistant.command("turn on the wake word")') // the command itself (no spoken confirmation: it would pause the wake word)
    ok('"turn on the wake word" is a local command', /Wake word on/.test(wakeSay))
    let listening = false
    for (let i = 0; i < 60 && !listening; i++) {
      listening = (await w.ev('document.body.dataset.listening')) === '1'
      await sleep(250)
    }
    ok('"Hey Jarvis" (from a WAV) opened the microphone', listening, JSON.stringify(await w.ev('window.__ws')))
    await w.ev('window.Voice.cancel()')
    await w.ev('window.Assistant.handle("wake word off")')
    await sleep(400)
    ok('wake word turned off again', (await w.ev('document.body.dataset.wake')) === '0')

    // inbox
    await w.ev('window.__inbox && window.__inbox.onItems([{id:1,app:"WhatsApp",appId:"x",title:"Mum",body:"dinner at eight",at:Date.now()}])')
    await sleep(300)
    ok('inbox shows a notification and counts it', (await w.ev('document.getElementById("icount").textContent')) === '1')
  } catch (e) {
    fails++
    console.log('FAIL  exception', e.message)
  }
  app.kill()
  server.close()
  console.log(fails ? `jarvis e2e: ${fails} FAILED` : 'jarvis e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
