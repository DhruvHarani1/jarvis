'use strict'
// Memory budget check (PLAN.md section 3): total working set of the app's whole process tree at idle, with the on-PC wake
// word listening, and after a spoken reply (voice model loaded).   node scripts/measure-ram.js
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function treeMB(pid) {
  const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize; $ids = @(${pid}); $grow = $true; while ($grow) { $grow = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $grow = $true } } }; $sum = 0; foreach ($p in $all) { if ($ids -contains $p.ProcessId) { $sum += $p.WorkingSetSize } }; [int]($sum / 1MB); $ids.Count`
  const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim().split(/\s+/)
  return { mb: +out[0], processes: +out[1] }
}

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
            pend.set(++id, (d) => r(d.result.result.value))
            ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } }))
          })
      }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('no page')
}

;(async () => {
  const electron = require(path.join(root, 'node_modules', 'electron'))
  const app = spawn(electron, ['.', '--remote-debugging-port=9338'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, SPIDEY_TEST: '1', JARVIS_TEST_KWS: '1', SPIDEY_FAKE_MIC_WAV: path.join(root, 'scratch', 'mic-plain.wav') }
  })
  try {
    const ev = await connect(9338)
    await sleep(8000)
    console.log('idle, wake word off      ', JSON.stringify(treeMB(app.pid)))
    await ev('window.Assistant.command("turn on the wake word")')
    await sleep(10000)
    console.log('wake word listening      ', JSON.stringify(treeMB(app.pid)))
    await ev('window.jarvis.speak("Good afternoon, sir. It is half past three, and you have two meetings today.")')
    await sleep(9000)
    console.log('after speaking (voice on)', JSON.stringify(treeMB(app.pid)))
  } finally {
    app.kill()
  }
})()
