'use strict'
// The smart wake word in the real app: the fake microphone plays a recording of "Hey Jarvis ..."; the speech model on this PC hears it,
// the page shows what was heard, and he wakes (either as a command with the rest of the sentence, or by starting to listen).
//   node scripts/e2e-wake-smart.js
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
  const app = spawn(electron, ['.', '--remote-debugging-port=9352'], { cwd: root, stdio: 'ignore', env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_KWS: '1', SPIDEY_FAKE_MIC_WAV: path.join(root, 'scratch', 'mic-hey-jarvis.wav'), JARVIS_MODELS_DIR: path.join(root, 'models-dev') } })
  let fails = 0
  const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`) }
  try {
    const w = await connect(9352)
    for (let i = 0; i < 40 && !(await w('!!window.Assistant')); i++) await sleep(500)
    await w('window.__heard = []; window.__cmd = []; window.jarvis.onWakeHeard((h) => window.__heard.push(h)); window.jarvis.onWakeCommand((t) => window.__cmd.push(t))')
    await w('window.jarvis.patchSettings({ wakeWord: true })')
    let heard = []
    for (let i = 0; i < 60 && !heard.some((h) => h.matched); i++) { await sleep(700); heard = JSON.parse(await w('JSON.stringify(window.__heard)')) }
    ok('the smart listener wrote down what it heard', heard.length > 0, JSON.stringify(heard.slice(0, 3)))
    ok('and found the name in it', heard.some((h) => h.matched), JSON.stringify(heard.slice(0, 3)))
    ok('the page shows it on the orb screen', /./.test(await w('document.getElementById("heard").textContent')))
  } catch (e) { fails++; console.log('FAIL  exception', e.message) }
  app.kill()
  console.log(fails ? `smart wake e2e: ${fails} FAILED` : 'smart wake e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
