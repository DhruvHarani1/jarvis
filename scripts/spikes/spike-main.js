'use strict'
// Spike A/B: does sherpa-onnx-node load inside an Electron utilityProcess, and does node:sqlite work in Electron main?
//   npx electron scripts/spikes/spike-main.js
const { app, utilityProcess } = require('electron')
const path = require('node:path')

app.whenReady().then(() => {
  const out = { electron: process.versions.electron, node: process.versions.node }
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES ('hello jarvis');")
    out.sqlite = { ok: true, fts5: db.prepare("SELECT count(*) c FROM t WHERE t MATCH 'jarvis'").get().c === 1 }
  } catch (e) {
    out.sqlite = { ok: false, error: String(e.message || e) }
  }
  const child = utilityProcess.fork(path.join(__dirname, 'spike-worker.js'))
  child.on('message', (m) => {
    console.log(JSON.stringify({ ...out, worker: m }, null, 2))
    child.kill()
    app.quit()
  })
  child.on('exit', (code) => {
    if (code) { console.log(JSON.stringify({ ...out, workerExit: code })); app.quit() }
  })
  setTimeout(() => { console.log('TIMEOUT'); app.exit(2) }, 30000)
})
