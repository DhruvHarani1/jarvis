'use strict'
// The Voice Lab page with a fake microphone (a recording of "Hey Jarvis"): microphone check, speech test across engines, wake test across sensitivities.
//   node scripts/e2e-lab.js
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function connect(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const pg = (await (await fetch(`http://localhost:${port}/json`)).json()).find((p) => p.url.includes('index.html'))
      if (pg) {
        const ws = new WebSocket(pg.webSocketDebuggerUrl)
        await new Promise((r) => (ws.onopen = r))
        let id = 0
        const pend = new Map()
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) pend.get(d.id)(d) }
        return (e) => new Promise((r) => { pend.set(++id, (d) => r(d.result && d.result.result ? d.result.result.value : undefined)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } })) })
      }
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('no page')
}
;(async () => {
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const app = spawn(electron, ['.', '--remote-debugging-port=9348'], { cwd: root, stdio: 'ignore', env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_LOCAL_STT: '1', SPIDEY_FAKE_MIC_WAV: path.join(root, 'scratch', 'mic-hey-jarvis.wav'), JARVIS_MODELS_DIR: path.join(root, 'models-dev') } })
  let fails = 0
  const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`) }
  const text = (id) => `document.getElementById("${id}").textContent`
  try {
    const w = await connect(9348)
    for (let i = 0; i < 40 && !(await w('!!window.Assistant && !!window.manageApi')); i++) await sleep(500)
    await w('document.dispatchEvent(new CustomEvent("settings-open", { detail: "lab" }))')
    await sleep(600)
    ok('the Lab page opens', (await w('document.getElementById("page-lab").hidden')) === false)

    await w('document.getElementById("l-mic").click()')
    let out = ''
    for (let i = 0; i < 40 && !out; i++) { await sleep(500); out = await w(text('l-micout')) }
    ok('the microphone check gives a verdict', out.length > 10, JSON.stringify(out.slice(0, 120)))

    await w('document.querySelector("#l-phrases button").click()')
    await sleep(3500)
    await w('document.querySelector("#l-phrases button").click()') // Stop
    let res = ''
    for (let i = 0; i < 60 && !/wrong/.test(res); i++) { await sleep(700); res = await w('document.querySelector("#l-phrases .s").textContent') }
    ok('the speech test shows what the engines heard, with a word-error score', /wrong/.test(res) && /on this PC/.test(res), res.slice(0, 200))

    // the fake microphone loops one recording, so a 3 s clip can start mid-phrase: allow a few tries
    let wr = ''
    for (let t = 1; t <= 3 && !/Balanced: woke on [1-9]/.test(wr); t++) {
      await w('document.getElementById("l-wakeyes").click()')
      for (let i = 0; i < 40 && !new RegExp(t + ' "Hey Jarvis" clip').test(wr); i++) { await sleep(700); wr = await w(text('l-wakeres')) }
    }
    ok('the wake test scores every sensitivity on the recording', /Balanced: woke on [1-9]/.test(wr), wr.slice(0, 250))
    await w('document.getElementById("l-waketalk").click()')
    for (let i = 0; i < 40 && !/1 ordinary/.test(wr); i++) { await sleep(900); wr = await w(text('l-wakeres')) }
    ok('talk clips are counted too', /1 ordinary-talk/.test(wr), wr.slice(0, 120))
  } catch (e) { fails++; console.log('FAIL  exception', e.message) }
  app.kill()
  console.log(fails ? `lab e2e: ${fails} FAILED` : 'lab e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
