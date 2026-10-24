'use strict'
// The first-run setup window: opens, shows what is ready (models, keys, accounts), the microphone check runs, and Done closes it for good.
//   node scripts/e2e-welcome.js
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
        return (e) => new Promise((r) => { pend.set(++id, (d) => r(d.result && d.result.result ? d.result.result.value : undefined)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } })) })
      }
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('no page ' + match)
}

;(async () => {
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const app = spawn(electron, ['.', '--remote-debugging-port=9342'], { cwd: root, stdio: 'ignore', env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_WELCOME: '1', SPIDEY_FAKE_MIC_WAV: path.join(root, 'scratch', 'mic-plain.wav'), JARVIS_MODELS_DIR: path.join(root, 'models-dev') } })
  let fails = 0
  const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`) }
  try {
    const w = await connect('welcome.html', 9342)
    for (let i = 0; i < 20 && (await w('document.readyState')) !== 'complete'; i++) await sleep(300)
    await sleep(800)
    ok('the setup window opens with its four steps', (await w('document.querySelectorAll("section.card").length')) === 4)
    ok('it knows the voice models are installed', /ready/.test(await w('document.getElementById("modelstate").textContent')) && (await w('document.getElementById("models").hidden')) === true, await w('document.getElementById("modelstate").textContent'))
    ok('the wake word switch is available because its model is installed', (await w('document.getElementById("wake").disabled')) === false)
    await w('document.getElementById("mic").click()')
    let msg = ''
    for (let i = 0; i < 30 && !/hear you|nothing|blocked|No microphone/.test(msg); i++) { await sleep(500); msg = await w('document.getElementById("micmsg").textContent') }
    ok('the microphone check finishes with an answer (fake microphone)', /hear you|nothing/.test(msg), JSON.stringify(msg))
    await w('document.getElementById("finish").click()')
    await sleep(1200)
    const pages = await (await fetch('http://localhost:9342/json')).json()
    ok('Done closes the window', !pages.some((p) => p.url.includes('welcome.html')))
  } catch (e) { fails++; console.log('FAIL  exception', e.message) }
  app.kill()
  console.log(fails ? `welcome e2e: ${fails} FAILED` : 'welcome e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
