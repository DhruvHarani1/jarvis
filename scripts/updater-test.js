'use strict'
// updater.js can only run inside Electron, so test the pure part (error wording) in plain Node by stubbing electron.
const assert = require('node:assert/strict')
const Module = require('node:module')
const orig = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { isPackaged: false } }
  return orig.call(this, request, ...rest)
}
const { updater, friendly } = require('../updater')

assert.match(friendly('getaddrinfo ENOTFOUND github.com'), /reach GitHub/)
assert.match(friendly('net::ERR_INTERNET_DISCONNECTED'), /reach GitHub/)
assert.match(friendly('Cannot find latest.yml in the latest release artifacts (404)'), /No update information/)
assert.match(friendly('HttpError: 403 rate limit exceeded'), /rate limiting/)
assert.equal(friendly('x'.repeat(500)).length, 160)
assert.equal(friendly(undefined), '')

// not packaged => disabled, never throws, install() is a no-op
const seen = []
updater.on('state', (s) => seen.push(s.state))
updater.start()
assert.deepEqual(seen, ['disabled'])
assert.equal(updater.state.state, 'disabled')
updater.install()
updater.dispose()
updater.check().then((s) => {
  assert.equal(s.state, 'disabled')
  console.log('updater: ALL PASS')
})
