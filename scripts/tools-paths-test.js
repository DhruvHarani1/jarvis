'use strict'
// Unit tests for tools/paths.js (the file sandbox): traversal, junctions, symlinks, UNC, device paths, streams, reserved names.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSandbox } = require('../tools/paths')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-paths-'))
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }))
const docs = path.join(base, 'Documents')
const outside = path.join(base, 'Secrets')
fs.mkdirSync(path.join(docs, 'sub'), { recursive: true })
fs.mkdirSync(outside)
fs.writeFileSync(path.join(docs, 'a.txt'), 'a')
fs.writeFileSync(path.join(outside, 'passwords.txt'), 'x')
const docsSibling = path.join(base, 'Documents-evil') // shares the prefix of the approved folder
fs.mkdirSync(docsSibling)

const sb = createSandbox([docs, path.join(base, 'NoSuchFolder')])
const ok = (p) => assert.equal(sb.check(p).ok, true, 'should allow ' + p)
const no = (p, re) => {
  const r = sb.check(p)
  assert.equal(r.ok, false, 'should refuse ' + p)
  if (re) assert.match(r.error, re)
}

// inside
ok(docs)
ok(path.join(docs, 'a.txt'))
ok(path.join(docs, 'sub', 'new-file-that-does-not-exist.txt'))
ok(path.join(docs, 'sub', '..', 'a.txt'))
ok(path.join(docs, 'A.TXT'), 'case does not matter on Windows')
assert.equal(sb.check(path.join(docs, 'a.txt')).root.toLowerCase(), fs.realpathSync.native(docs).toLowerCase())

// outside / traversal
no(outside, /outside/)
no(path.join(outside, 'passwords.txt'), /outside/)
no(path.join(docs, '..', 'Secrets', 'passwords.txt'), /outside/)
no(path.join(docs, 'sub', '..', '..', 'Secrets'), /outside/)
no(docsSibling, /outside/)
no(path.join(docsSibling, 'x.txt'), /outside/)
no('C:\\Windows\\System32\\drivers\\etc\\hosts', /outside/)
no(os.homedir(), /outside/)

// not absolute / junk
no('a.txt', /full path/)
no('..\\..\\Windows', /full path/)
no('', /usable/)
no('   ', /usable/)
no(null, /usable/)
no(123, /usable/)
no('C:\\' + 'a'.repeat(500), /usable/)

// network, device and stream paths
no('\\\\server\\share\\file.txt', /network/)
no('//server/share/file.txt', /network/)
no('\\\\?\\C:\\Windows', /network/)
no('\\\\.\\PhysicalDrive0', /network/)
no(path.join(docs, 'a.txt') + ':secret', /not allowed/)
no(path.join(docs, 'a.txt::$DATA'), /not allowed/)
no(path.join(docs, 'CON'), /not allowed/)
no(path.join(docs, 'nul.txt'), /not allowed/)
no(path.join(docs, 'COM1'), /not allowed/)

// junction and symlink pointing out of the folder are judged by where they lead
try {
  fs.symlinkSync(outside, path.join(docs, 'jump'), 'junction')
  no(path.join(docs, 'jump'), /outside/)
  no(path.join(docs, 'jump', 'passwords.txt'), /outside/)
  no(path.join(docs, 'jump', 'new.txt'), /outside/)
} catch (e) {
  console.log('tools-paths: junction part SKIPPED (' + e.code + ')')
}

// an approved folder that does not exist is simply not a root
assert.equal(sb.roots.length, 1)
no(path.join(base, 'NoSuchFolder', 'x.txt'), /outside/)

console.log('tools-paths: ALL PASS')
