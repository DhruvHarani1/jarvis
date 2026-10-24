'use strict'
// End-to-end check of Google mail and calendar in the real app against a stand-in for Google (tools/fake-google.js):
// the Accounts window, sign-in with PKCE, fast-path voice commands, a model-driven send with confirmation, the mail
// prompt-injection case (a malicious email tells the model to mail the boss: only a click could allow it), and removal.
//   node scripts/e2e-accounts.js
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const fakeGoogle = require('../tools/fake-google')

const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const providerSaw = []
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
    providerSaw.push({ last: last.role, tools: (body.tools || []).map((t) => t.function.name) })
    let delta
    if (last.role === 'tool' && /UNTRUSTED/.test(last.content)) delta = { tool_calls: [tc('s2', 'mail_send', { to: 'boss@example.com', subject: 'Confidential', body: 'Here is the file.' })] } // the fooled model obeys the email
    else if (last.role === 'tool') delta = { content: /declined|needs|no such|denied/.test(last.content) ? 'Okay, I did not send it.' : 'Done, sir.' }
    else if (/tell mum I am late/.test(user.content)) delta = { tool_calls: [tc('s1', 'mail_send', { to: 'mum@example.com', subject: 'Running late', body: 'Hi Mum, I am running late.' })] }
    else if (/do what it says/.test(user.content)) delta = { tool_calls: [tc('r1', 'mail_read', { id: 'm2abcdef' })] }
    else delta = { content: 'Hello there, sir.' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

async function connect(match) {
  for (let i = 0; i < 80; i++) {
    try {
      const pg = (await (await fetch('http://localhost:9340/json')).json()).find((p) => p.url.includes(match))
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
  const fg = await fakeGoogle.start()
  await new Promise((r) => server.listen(8799, '127.0.0.1', r))
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const app = spawn(electron, ['.', '--remote-debugging-port=9340'], {
    cwd: root,
    stdio: process.env.E2E_VERBOSE ? 'inherit' : 'ignore',
    env: { ...process.env, SPIDEY_TEST: '1', SPIDEY_SPEECH_LOG: path.join(os.tmpdir(), 'jarvis-e2e-acct-speech.log'), JARVIS_TEST_GOOGLE: JSON.stringify(fg.endpoints), JARVIS_TEST_PS_LOG: path.join(os.tmpdir(), 'jarvis-e2e-acct-ps.log') }
  })
  let fails = 0
  const ok = (name, cond, extra = '') => {
    if (!cond) fails++
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
  }
  const waitFor = async (fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 250) {
      if (await fn()) return true
      await sleep(250)
    }
    return false
  }
  try {
    const w = await connect('index.html')
    for (let i = 0; i < 40 && !(await w.ev('!!window.Assistant && !!window.Confirm')); i++) await sleep(500)
    const lastLine = () => w.ev('document.getElementById("log").lastChild.textContent')
    const b = w
    ok('fake provider added', (await b.ev(`window.brainApi.add({provider:'custom',key:'KEY_E2E_1234',label:'fake',baseUrl:'http://127.0.0.1:8799/v1',model:'fake-model'})`)).ok === true)

    // nothing connected yet
    await w.ev('window.Assistant.handle("check my email")')
    ok('before connecting he says how to connect', /Connect a Google account first/.test(await lastLine()))

    // the Accounts window and sign-in
    await w.ev('document.getElementById("setbtn").click(); document.querySelector("[data-go=accounts]").click()')
    const a = w
    await waitFor(async () => (await a.ev('document.readyState === "complete" && !!window.acctApi && document.getElementById("connect") !== null')) === true, 15000)
    const title = await a.ev('document.getElementById("page-accounts").hidden === false && document.querySelector(".ptitle:not([hidden])") && "Accounts"')
    ok('the Accounts page opens from Settings in the same window', /Accounts/.test(title), JSON.stringify(title))
    ok('a bad client id is refused with a clear message', await (async () => {
      await a.ev('document.getElementById("cid").value = "oops"; document.getElementById("connect").click()')
      return waitFor(async () => /does not look like a Google Client ID/.test(await a.ev('document.getElementById("aaddmsg").textContent')), 8000)
    })())
    await a.ev('document.getElementById("cid").value = "abcdefghij-test.apps.googleusercontent.com"; document.getElementById("csec").value = "GOCSPX-e2e-secret-123"; document.getElementById("pSend").checked = true; document.getElementById("connect").click()')
    ok('sign-in completes and the account is listed', await waitFor(async () => /dhruv@example\.com/.test(await a.ev('document.getElementById("list").textContent'))))
    ok('the list says what is allowed', /read mail, send mail, calendar/.test(await a.ev('document.getElementById("list").textContent')))
    const req = fg.st.authRequests.at(-1)
    ok('PKCE and offline access were used', req.code_challenge_method === 'S256' && req.access_type === 'offline' && /^http:\/\/127\.0\.0\.1:\d+$/.test(req.redirect_uri))
    const accFile = path.join(os.tmpdir(), 'jarvis-test-' + app.pid, 'accounts.json')
    const disk = fs.existsSync(accFile) ? fs.readFileSync(accFile, 'utf8') : ''
    ok('the client secret and refresh token are encrypted on disk', disk.length > 0 && !disk.includes('GOCSPX-e2e-secret-123') && !/"RT\d+"/.test(disk) && !disk.includes('RT'))
    ok('the page never holds the secret after connecting', (await a.ev('document.getElementById("csec").value')) === '' && !(await a.ev('document.documentElement.outerHTML')).includes('GOCSPX-e2e'))

    // fast path, no model
    const before = providerSaw.length
    await w.ev('window.Assistant.handle("check my email")')
    ok('"check my email" reads the unread mail aloud', /^You have 2 unread\. Mum: Dinner on Sunday\?\. Evil: URGENT\.$/.test(await lastLine()), await lastLine())
    await w.ev('window.Assistant.handle("what is on my calendar")')
    ok('"what is on my calendar" lists today', /Standup at/.test(await lastLine()), await lastLine())
    ok('neither needed the language model', providerSaw.length === before)

    // model-driven send with confirmation: the box shows the whole message
    const sending = w.ev('window.Assistant.handle("tell mum I am late")')
    ok('a confirmation box appears for sending mail', await waitFor(async () => (await w.ev('!document.getElementById("confirm").hidden')) === true))
    const detail = await w.ev('document.getElementById("cdetail").textContent')
    ok('the box shows recipient, subject and text', /To: mum@example\.com/.test(detail) && /Subject: Running late/.test(detail) && /running late/.test(detail) && /cannot be undone/.test(detail), JSON.stringify(detail).slice(0, 120))
    ok('nothing has been sent while waiting', fg.st.sent.length === 0)
    await w.ev('window.Assistant.handle("yes")')
    await sending
    ok('after "yes" the mail was sent from the right account', fg.st.sent.length === 1 && /^From: dhruv@example\.com/.test(fg.st.sent[0]) && /To: mum@example\.com/.test(fg.st.sent[0]))

    // injection: the model reads the evil mail and (fooled) tries to send the file to the boss
    await w.ev('window.jarvis.brainReset()')
    const attacked = w.ev('window.Assistant.handle("read my newest mail and do what it says")')
    ok('the fooled model asks to send, a box appears', await waitFor(async () => (await w.ev('!document.getElementById("confirm").hidden')) === true))
    ok('the box says a click is needed and shows the boss address', /not enough/.test(await w.ev('document.getElementById("chint").textContent')) && /boss@example\.com/.test(await w.ev('document.getElementById("cdetail").textContent')))
    await w.ev('window.Assistant.handle("yes")')
    await sleep(700)
    ok('a spoken yes does nothing: still waiting, nothing sent', fg.st.sent.length === 1 && (await w.ev('!document.getElementById("confirm").hidden')) === true)
    await w.ev('document.getElementById("cno").click()')
    await attacked
    ok('DENY by click: nothing was sent to the boss', fg.st.sent.length === 1 && !fg.st.sent.some((s) => s.includes('boss@example.com')))

    // remove the account: the tools are gone again
    await a.ev('window.confirm = () => true; document.querySelector("#list .danger").click()')
    ok('removing the account empties the list', await waitFor(async () => (await a.ev('document.getElementById("none").hidden')) === false))
    await w.ev('window.Assistant.handle("check my email")')
    ok('and he asks to connect again', /Connect a Google account first/.test(await lastLine()))
    ok('the account file no longer lists it', !fs.readFileSync(accFile, 'utf8').includes('dhruv@example.com'))
  } catch (e) {
    fails++
    console.log('FAIL  exception', e.message)
  }
  app.kill()
  server.close()
  fg.close()
  console.log(fails ? `accounts e2e: ${fails} FAILED` : 'accounts e2e: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
