'use strict'
const t0 = Date.now()
try {
  const sherpa = require('sherpa-onnx-node')
  process.parentPort.postMessage({
    ok: true,
    loadMs: Date.now() - t0,
    version: sherpa.version,
    exports: Object.keys(sherpa).slice(0, 30),
    rssMB: Math.round(process.memoryUsage().rss / 1048576)
  })
} catch (e) {
  process.parentPort.postMessage({ ok: false, error: String(e && e.stack || e) })
}
