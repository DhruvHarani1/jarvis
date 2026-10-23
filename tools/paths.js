'use strict'
/**
 * The file sandbox. File tools only ever touch paths inside folders the user has approved (default: Desktop, Documents,
 * Downloads, Pictures, Music, Videos). A path is judged AFTER it has been made absolute and its links resolved, so "..",
 * junctions and symlinks cannot walk out. Network paths, device paths and alternate data streams are refused outright.
 */
const fs = require('node:fs')
const path = require('node:path')

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const lower = (p) => p.toLowerCase()

function realpath(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/** resolve a not-yet-existing path through its nearest existing parent */
function realish(p) {
  const abs = path.resolve(p)
  const real = realpath(abs)
  if (real) return real
  const parent = path.dirname(abs)
  if (parent === abs) return abs
  const rp = realish(parent)
  return rp ? path.join(rp, path.basename(abs)) : abs
}

/**
 * @param {string[]} roots approved folders
 */
function createSandbox(roots) {
  const real = roots.map(realpath).filter(Boolean)

  /** @returns {{ok:true, path:string, root:string}|{ok:false, error:string}} */
  function check(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 400) return { ok: false, error: 'that is not a usable path' }
    const s = input.trim()
    if (s.startsWith('\\\\') || s.startsWith('//')) return { ok: false, error: 'network and device paths are not allowed' }
    if (/^[a-zA-Z]:/.test(s) ? s.indexOf(':', 2) >= 0 : s.includes(':')) return { ok: false, error: 'that path is not allowed' }
    for (const part of s.split(/[\\/]/)) if (RESERVED.test(part.trim())) return { ok: false, error: 'that path is not allowed' }
    if (!path.isAbsolute(s)) return { ok: false, error: 'give the full path, or a name to search for' }
    const resolved = realish(s)
    for (const r of real) {
      const a = lower(resolved)
      const b = lower(r)
      if (a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)) return { ok: true, path: resolved, root: r }
    }
    return { ok: false, error: 'that is outside the folders I am allowed to use' }
  }

  return { check, roots: real }
}

module.exports = { createSandbox, realish }
