'use strict'
// The Tools, Memory and Activity pages of the single window (the warning boxes for Power mode and screen vision are native and not driven here).
//   node scripts/e2e-pages.js
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
  const app = spawn(electron, ['.', '--remote-debugging-port=9347'], { cwd: root, stdio: 'ignore', env: { ...process.env, SPIDEY_TEST: '1', JARVIS_MODELS_DIR: path.join(root, 'models-dev') } })
  let fails = 0
  const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`) }
  const open = (p) => `document.dispatchEvent(new CustomEvent("settings-open", { detail: "${p}" }))`
  try {
    const w = await connect(9347)
    for (let i = 0; i < 40 && !(await w('!!window.Assistant && !!window.manageApi')); i++) await sleep(500)
    await w(open('tools'))
    await sleep(800)
    ok('the Tools page lists the tools', (await w('document.querySelectorAll("#t-list input").length')) > 5)
    ok('"Jarvis can act" is on by default', (await w('document.getElementById("t-actions").checked')) === true)
    ok('Power mode and screen understanding start off', (await w('document.getElementById("t-power").checked || document.getElementById("t-screen").checked')) === false)
    await w('document.querySelector("#t-list input").click()')
    await sleep(600)
    ok('turning one tool off sticks', (await w('document.querySelector("#t-list input").checked')) === false)
    await w('document.querySelector("#t-list input").click()')
    await sleep(600)
    ok('and back on', (await w('document.querySelector("#t-list input").checked')) === true)

    await w('window.Assistant.handle("remember that my favourite tea is masala chai")')
    await sleep(800)
    await w(open('memory'))
    await sleep(800)
    ok('the Memory page shows what was remembered', /masala chai/.test(await w('document.getElementById("m-facts").textContent')), await w('document.getElementById("m-facts").textContent'))
    await w('document.querySelector("#m-facts .danger").click()')
    await sleep(700)
    ok('Forget removes it', !/masala chai/.test(await w('document.getElementById("m-facts").textContent')))

    // FreeLLMAPI detection: nothing there, then a stand-in server that answers like it (401 without its key)
    await w(open('brain'))
    await sleep(500)
    await w('document.getElementById("fl-find").click()')
    await sleep(2500)
    ok('no FreeLLMAPI: he says so', /Not running/.test(await w('document.getElementById("fl-msg").textContent')), await w('document.getElementById("fl-msg").textContent'))
    const fl = require('node:http').createServer((req, res) => { res.statusCode = 401; res.end('{"error":"key"}') })
    await new Promise((r) => fl.listen(31415, '127.0.0.1', r))
    await w('document.getElementById("fl-find").click()')
    await sleep(2500)
    fl.close()
    ok('FreeLLMAPI running: found, provider and address filled in', /Found it at http:\/\/127\.0\.0\.1:31415\/v1/.test(await w('document.getElementById("fl-msg").textContent')) && (await w('document.getElementById("provider").value')) === 'freellmapi' && (await w('document.getElementById("baseUrl").value')) === 'http://127.0.0.1:31415/v1', await w('document.getElementById("fl-msg").textContent'))

    await w(open('activity'))
    await sleep(800)
    ok('the Activity page lists what he did', /remember/.test(await w('document.getElementById("a-list").textContent')), (await w('document.getElementById("a-list").textContent')).slice(0, 120))
  } catch (e) { fails++; console.log('FAIL  exception', e.message) }
  app.kill()
  console.log(fails ? `pages e2e: ${fails} FAILED` : 'pages e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
