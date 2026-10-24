'use strict'
// Smoke test of the PACKAGED app (release/win-unpacked/Jarvis.exe): it starts, the window loads, the audio worker starts from inside
// the asar archive with the native speech library unpacked beside it, the natural voice speaks and Moonshine hears.
// Build first:  npx electron-builder --win --dir "-c.electronDist=node_modules/electron/dist" "-c.electronVersion=44.7.2"
//   node scripts/smoke-packaged.js
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.join(__dirname, '..')
const exe = path.join(root, 'release', 'win-unpacked', 'Jarvis.exe')
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
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data)
          if (d.id && pend.has(d.id)) pend.get(d.id)(d)
        }
        return (e) =>
          new Promise((r) => {
            pend.set(++id, (d) => r(d.result && d.result.result ? d.result.result.value : undefined))
            ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } }))
          })
      }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('the packaged app did not open its window')
}

;(async () => {
  if (!fs.existsSync(exe)) {
    console.log('smoke SKIPPED: build the unpacked app first (see the header of this file)')
    process.exit(0)
  }
  const app = spawn(exe, ['--remote-debugging-port=9341'], {
    stdio: 'ignore',
    env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_LOCAL_STT: '1', JARVIS_MODELS_DIR: path.join(root, 'models-dev') }
  })
  let fails = 0
  const ok = (name, cond, extra = '') => {
    if (!cond) fails++
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
  }
  try {
    const ev = await connect(9341)
    for (let i = 0; i < 40 && !(await ev('!!window.Assistant && !!window.Voice')); i++) await sleep(500)
    ok('the packaged app opened and the page is alive', (await ev('!!window.Assistant && !!window.Confirm && document.title')) === 'Jarvis')
    await ev('window.__plays = 0; window.jarvis.onTtsPlay(() => window.__plays++)')
    await ev('window.jarvis.speak("Good afternoon, sir.")')
    let plays = 0
    for (let i = 0; i < 80 && !plays; i++) {
      await sleep(500)
      plays = await ev('window.__plays')
    }
    ok('the natural voice spoke from the packaged app (audio worker and native library work inside the install)', plays >= 1, `plays=${plays}`)
    const wav = path.join(root, 'scratch', 'e2e-last.wav')
    if (fs.existsSync(wav)) {
      const b64 = fs.readFileSync(wav).toString('base64')
      const res = await ev(`(async () => { const b = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0)); return await window.jarvis.transcribe(b.buffer) })()`)
      ok('Moonshine heard the recording in the packaged app', !!res && res.ok === true && /cpu/i.test(res.text || ''), JSON.stringify(res && { text: res.text, via: res.via }))
    } else console.log('SKIP  transcription check (scratch/e2e-last.wav missing)')
  } catch (e) {
    fails++
    console.log('FAIL  exception', e.message)
  }
  app.kill()
  console.log(fails ? `packaged smoke: ${fails} FAILED` : 'packaged smoke: ALL PASS')
  process.exit(fails ? 1 : 0)
})()
