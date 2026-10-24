'use strict'
// Takes screenshots of every Jarvis window (main, AI keys, Accounts, Setup) into scratch/shots/ so the look can be checked by eye.
//   node scripts/screenshots.js
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.join(__dirname, '..')
const out = path.join(root, 'scratch', 'shots')
fs.mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function page(match, port) {
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
        const send = (method, params = {}) => new Promise((r) => { pend.set(++id, (d) => r(d.result)); ws.send(JSON.stringify({ id, method, params })) })
        return { send, ev: async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value }
      }
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('no page ' + match)
}
const shot = async (p, name) => {
  const r = await p.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64'))
  console.log('saved', name)
}

;(async () => {
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const app = spawn(electron, ['.', '--remote-debugging-port=9345'], { cwd: root, stdio: 'ignore', env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_WELCOME: '1', SPIDEY_FAKE_MIC_WAV: path.join(root, 'scratch', 'mic-plain.wav'), JARVIS_MODELS_DIR: path.join(root, 'models-dev') } })
  try {
    const main = await page('index.html', 9345)
    for (let i = 0; i < 30 && !(await main.ev('!!window.Assistant')); i++) await sleep(400)
    await main.ev('document.getElementById("log").replaceChildren(); window.Assistant && 0')
    await main.ev(`(() => { const add = (c, t) => { const li = document.createElement('li'); li.className = c; li.textContent = t; document.getElementById('log').append(li) }; add('me', 'what is on my calendar today'); add('jarvis', 'You have 2 events today: Standup at 10:00 AM, Dentist at 4:00 PM.'); add('me', 'send a whatsapp to mum saying I will be late'); add('jarvis', 'Sent to Mum.'); document.getElementById('caption').textContent = 'LISTENING…' })()`)
    await sleep(500)
    await shot(main, 'main')
    await main.ev('document.body.dataset.voice = "listening"; document.body.style.setProperty("--lvl", "0.7")')
    await main.ev(`window.dispatchEvent(new Event('x')); (function(){ const c = document.getElementById('confirm'); document.getElementById('ctitle').textContent = 'SEND A WHATSAPP MESSAGE'; document.getElementById('cdetail').textContent = 'WhatsApp message\\nTo: Mum (+91 •••••••210)\\n\\nI will be late\\n\\n(This cannot be undone.)'; document.getElementById('chint').textContent = 'Click ALLOW or DENY, or just say yes or no.'; c.hidden = false })()`)
    await sleep(500)
    await shot(main, 'main-confirm')
    const welcome = await page('welcome.html', 9345)
    await sleep(900)
    await shot(welcome, 'welcome')
    await main.ev('window.jarvis.openBrain()')
    const brain = await page('brain.html', 9345)
    await sleep(900)
    await shot(brain, 'brain')
    await main.ev('window.jarvis.openAccounts()')
    const acct = await page('accounts.html', 9345)
    await sleep(900)
    await shot(acct, 'accounts')
  } catch (e) {
    console.log('ERR', e.message)
  }
  app.kill()
  process.exit(0)
})()
