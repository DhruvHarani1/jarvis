'use strict'
// The "About and updates" card and the download progress bar in the single window.
//   node scripts/e2e-updates.js
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
  const app = spawn(electron, ['.', '--remote-debugging-port=9349'], { cwd: root, stdio: 'ignore', env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_DL_DEMO: '1' } })
  let fails = 0
  const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`) }
  const text = (id) => `document.getElementById("${id}").textContent`
  try {
    const w = await connect(9349)
    for (let i = 0; i < 40 && !(await w('!!window.Assistant')); i++) await sleep(500)
    for (let i = 0; i < 20 && (await w('document.getElementById("dl").hidden')) !== false; i++) await sleep(400)
    ok('a download shows a progress bar with name, percent and sizes', /Parakeet speech model \(1 of 2\) · 42% · 200\.0 MB of 480\.0 MB/.test(await w(text('dl-text'))), await w(text('dl-text')))
    ok('the bar is filled to the percentage', (await w('document.getElementById("dl-fill").style.width')) === '42%')
    await w('document.dispatchEvent(new CustomEvent("settings-open", { detail: "general" }))')
    await sleep(600)
    ok('the General page shows the version', /^Jarvis \d+\.\d+\.\d+/.test(await w(text('u-version'))), await w(text('u-version')))
    await w('document.getElementById("u-check").click()')
    await sleep(800)
    ok('the update check always says something (not installed here, so it says why)', (await w(text('u-status'))).length > 10, await w(text('u-status')))
  } catch (e) { fails++; console.log('FAIL  exception', e.message) }
  app.kill()
  console.log(fails ? `updates e2e: ${fails} FAILED` : 'updates e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
