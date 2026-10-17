'use strict'
// Wiring checks for the Jarvis shell: everything the renderer calls exists in the preload, every preload channel has a handler in main,
// every script and element the page needs is there. (No Electron needed.)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const preload = read('preload.js')
const main = read('main.js')
const html = read('renderer/index.html')

// 1) renderer -> preload
const api = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]))
const rendererFiles = ['jarvis.js', 'voice.js', 'inbox.js', 'reader.js']
for (const f of rendererFiles) {
  for (const m of read('renderer/' + f).matchAll(/window\.jarvis\.(\w+)/g)) assert.ok(api.has(m[1]), `${f} uses window.jarvis.${m[1]}, which the preload does not expose`)
}

// 2) preload -> main
const invoked = [...preload.matchAll(/ipcRenderer\.(invoke|send)\('([\w:]+)'/g)].map((m) => [m[1], m[2]])
for (const [kind, ch] of invoked) {
  const re = new RegExp(`ipcMain\\.${kind === 'invoke' ? 'handle' : 'on'}\\('${ch}'`)
  assert.match(main, re, `main has no ${kind === 'invoke' ? 'handler' : 'listener'} for ${ch}`)
}
// main -> preload (events the window listens to)
for (const m of main.matchAll(/webContents\.send\('([\w:-]+)'/g)) assert.ok(preload.includes(`'${m[1]}'`), `main sends ${m[1]} but the preload never listens for it`)

// 3) page: scripts exist, in an order where Core exists before its users
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
for (const s of scripts) assert.ok(fs.existsSync(path.join(root, 'renderer', s)), 'missing script ' + s)
assert.ok(scripts.indexOf('jarvis.js') < scripts.indexOf('voice.js'))
assert.ok(scripts.indexOf('voice-core.js') < scripts.indexOf('voice.js'))
assert.ok(scripts.indexOf('inbox.js') < scripts.indexOf('reader.js'), 'the reader needs the inbox')
assert.ok(fs.existsSync(path.join(root, 'renderer', 'pcm-worklet.js')))
assert.match(html, /script-src 'self'/, 'strict CSP: no inline scripts')
assert.ok(!/<script>/.test(html))

// 4) ids the scripts look up
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
for (const f of rendererFiles) {
  const src = read('renderer/' + f)
  for (const m of src.matchAll(/\$\('([\w-]+)'\)/g)) assert.ok(ids.has(m[1]), `${f} looks up #${m[1]} which index.html does not have`)
}

// 5) things that must NOT be in Jarvis (they live in Spidey Sense)
for (const gone of ['guardian', 'edith', 'bugle', 'startCapture', 'capWin', 'desktopCapturer', 'taskkill', 'powerMonitor']) assert.ok(!new RegExp(gone, 'i').test(main), `main.js should not mention ${gone}`)
for (const f of rendererFiles) assert.ok(!/window\.spidey\b/.test(read('renderer/' + f)), `${f} still uses window.spidey`)

// 6) package files list covers every module main.js requires
const pkg = JSON.parse(read('package.json'))
const files = new Set(pkg.build.files)
for (const m of main.matchAll(/require\('\.\/([\w-]+)'\)/g)) assert.ok(files.has(m[1] + '.js'), `${m[1]}.js is required by main.js but not packaged`)
for (const f of ['preload.js', 'preload-brain.js']) assert.ok(files.has(f), f + ' is not packaged')
assert.equal(pkg.build.appId, 'dev.jarvis.assistant')
assert.equal(pkg.devDependencies.electron, '44.7.2')

console.log('jarvis: ALL PASS')
