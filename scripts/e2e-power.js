'use strict'
// Power mode in the real app, twice: OFF (the commands do not exist for the AI model and "run powershell" is declined) and ON (every call needs a click,
// a spoken "yes" is ignored, dangerous commands are refused even after a click, nothing runs without Allow). A stand-in records what would have run.
//   node scripts/e2e-power.js
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const seenTools = []
const tc = (id, name, args) => ({ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const server = http.createServer((req, res) => {
  let data = ''
  req.on('data', (c) => (data += c))
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }), res.end('{"data":[{"id":"fake-model"}]}')
    const body = JSON.parse(data || '{}')
    const msgs = body.messages || []
    const last = msgs.at(-1) || {}
    const user = [...msgs].reverse().find((m) => m.role === 'user')
    seenTools.push((body.tools || []).map((t) => t.function.name))
    let delta
    if (last.role === 'tool') delta = { content: /will not run|declined|denied|off/.test(last.content) ? 'Okay, I did not run it.' : 'Done, sir.' }
    else if (/wipe the d drive/.test(user.content)) delta = { tool_calls: [tc('p1', 'run_powershell', { command: 'Format-Volume -DriveLetter D' })] }
    else if (/check the time with a command/.test(user.content)) delta = { tool_calls: [tc('p2', 'run_powershell', { command: 'Get-Date' })] }
    else delta = { content: 'Hello there, sir.' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

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

async function session(powerOn, port, checks) {
  const log = path.join(os.tmpdir(), `jarvis-e2e-power-${port}.log`)
  fs.rmSync(log, { force: true })
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const env = { ...process.env, SPIDEY_TEST: '1', SPIDEY_SPEECH_LOG: path.join(os.tmpdir(), 'jarvis-e2e-power-speech.log'), JARVIS_TEST_PS_LOG: log }
  if (powerOn) env.JARVIS_TEST_POWER = '1'
  else delete env.JARVIS_TEST_POWER
  const app = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: root, stdio: 'ignore', env })
  try {
    const w = await connect('index.html', port)
    for (let i = 0; i < 40 && !(await w('!!window.Assistant && !!window.Confirm')); i++) await sleep(500)
    const b = w
    await b(`window.brainApi.add({provider:'custom',key:'KEY_E2E_1234',label:'fake',baseUrl:'http://127.0.0.1:8799/v1',model:'fake-model'})`)
    const execs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.which === 'exec') : [])
    await checks({ w, execs })
  } finally {
    app.kill()
  }
}

;(async () => {
  await new Promise((r) => server.listen(8799, '127.0.0.1', r))
  let fails = 0
  const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`) }
  const line = (w) => w('document.getElementById("log").lastChild.textContent')
  const waitBox = async (w) => { for (let i = 0; i < 60; i++) { if ((await w('!document.getElementById("confirm").hidden')) === true) return true; await sleep(250) } return false }
  try {
    await session(false, 9343, async ({ w, execs }) => {
      await w('window.Assistant.handle("run powershell Get-Date")')
      ok('OFF: "run powershell" is declined with an explanation', /Power mode is off/.test(await line(w)), await line(w))
      await w('window.Assistant.handle("hello")')
      ok('OFF: the AI model is not offered the Power mode tools', seenTools.length > 0 && seenTools.every((t) => !t.includes('run_powershell') && !t.includes('type_into_app') && !t.includes('ui_click')))
      ok('OFF: nothing ran', execs().length === 0)
    })
    seenTools.length = 0
    await session(true, 9344, async ({ w, execs }) => {
      const asking = w('window.Assistant.handle("run powershell Get-Date")')
      ok('ON: a box appears with the exact command', await waitBox(w) && /Get-Date/.test(await w('document.getElementById("cdetail").textContent')))
      ok('ON: it says a click is needed even though nothing untrusted was read', /not enough/.test(await w('document.getElementById("chint").textContent')))
      await w('window.Assistant.handle("yes")')
      await sleep(700)
      ok('ON: a spoken yes does nothing, still waiting, nothing ran', execs().length === 0 && (await w('!document.getElementById("confirm").hidden')) === true)
      await w('document.getElementById("cyes").click()')
      await asking
      ok('ON: after the click the command ran and its output came back', execs().length === 1 && execs()[0].arg === 'Get-Date' && /fake output/.test(await line(w)), await line(w))

      await w('window.jarvis.brainReset()')
      const risky = w('window.Assistant.handle("wipe the d drive")')
      ok('ON: the model asks for a dangerous command, the box shows REFUSED', await waitBox(w) && /REFUSED: it could wipe or damage a disk/.test(await w('document.getElementById("cdetail").textContent')))
      await w('document.getElementById("cyes").click()')
      await risky
      ok('ON: even after Allow the dangerous command never ran', execs().length === 1 && /did not run/.test(await line(w)), await line(w))
      ok('ON: the model was offered the Power mode tools', seenTools.some((t) => t.includes('run_powershell')))
      const deny = w('window.Assistant.handle("check the time with a command")')
      await waitBox(w)
      await w('document.getElementById("cno").click()')
      await deny
      ok('ON: Deny keeps everything stopped', execs().length === 1)
    })
  } catch (e) {
    fails++
    console.log('FAIL  exception', e.message)
  }
  server.close()
  console.log(fails ? `power e2e: ${fails} FAILED` : 'power e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
