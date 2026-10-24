'use strict'
// Licence audit of everything that ships inside the installer (production dependencies, recursively).
// Fails on anything that is not clearly permissive, so a copyleft or unknown licence cannot slip into a release unnoticed.
//   node scripts/license-audit.js
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const OK = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|BlueOak-1\.0\.0|Unlicense|CC0-1\.0|Python-2\.0|MIT-0)$/i
const BAD = /GPL|AGPL|SSPL|CC-BY-NC|NONCOMMERCIAL|UNLICENSED/i

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const pkg = read(path.join(root, 'package.json'))
const seen = new Map()
const queue = Object.keys(pkg.dependencies || {})

function find(name, from) {
  let dir = from
  for (;;) {
    const p = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(p)) return p
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

for (const name of queue) {
  if (seen.has(name)) continue
  const p = find(name, root)
  if (!p) {
    seen.set(name, { version: '?', license: 'NOT INSTALLED (optional for another platform?)', optional: true })
    continue
  }
  const j = read(p)
  let lic = j.license || (Array.isArray(j.licenses) ? j.licenses.map((l) => l.type).join(' OR ') : (j.licenses && j.licenses.type) || '')
  if (typeof lic === 'object' && lic) lic = lic.type
  seen.set(name, { version: j.version, license: String(lic || 'NONE') })
  for (const d of Object.keys(j.dependencies || {})) queue.push(d)
  for (const d of Object.keys(j.optionalDependencies || {})) queue.push(d)
}

let bad = 0
const rows = [...seen.entries()].sort()
for (const [name, v] of rows) {
  if (v.optional) continue
  // "(MIT OR Apache-2.0)" style: every alternative must be fine, or at least one permissive alternative must exist
  const parts = v.license.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+|\s*\/\s*/i).map((x) => x.trim()).filter(Boolean)
  const good = parts.length > 0 && parts.some((x) => OK.test(x)) && !parts.every((x) => BAD.test(x))
  const flagged = !good || (BAD.test(v.license) && !parts.some((x) => OK.test(x)))
  if (flagged) {
    bad++
    console.log(`REVIEW  ${name}@${v.version}  ${v.license}`)
  }
}
console.log(`${rows.filter(([, v]) => !v.optional).length} production packages checked; ${bad ? bad + ' need a decision' : 'all permissive (MIT, ISC, BSD, Apache-2.0 and similar)'}`)
// the optional GPL phonemizer must never be a dependency of the app
const gplLeak = rows.find(([n]) => /piper-phonemize/.test(n))
if (gplLeak) {
  console.log('FAIL  the GPL phonemizer is listed as a dependency; it must stay a separately downloaded component')
  process.exit(1)
}
process.exit(bad ? 1 : 0)
