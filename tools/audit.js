'use strict'
/**
 * Append-only activity log of everything Jarvis did (or was refused). One JSON object per line, rotated at 2 MB (one old
 * file kept). Arguments are shortened and anything that looks like a secret is masked before it is written.
 */
const fs = require('node:fs')
const path = require('node:path')

const MAX_BYTES = 2 * 1024 * 1024
const SECRET_KEY = /key|token|secret|password|passwd|authorization|cookie/i
const MAX_STR = 200

function redact(v, depth = 0) {
  if (v === null || v === undefined) return v
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + `…(+${v.length - MAX_STR})` : v
  if (typeof v !== 'object') return v
  if (depth > 3) return '…'
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1))
  const out = {}
  for (const k of Object.keys(v).slice(0, 30)) out[k] = SECRET_KEY.test(k) ? '***' : redact(v[k], depth + 1)
  return out
}

/** @param {{file:string, now?:()=>number}} o */
function create({ file, now = Date.now }) {
  function rotate() {
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1')
    } catch {
      /* no file yet */
    }
  }
  function log(entry) {
    const line = JSON.stringify({ t: new Date(now()).toISOString(), ...entry, args: redact(entry.args), result: redact(entry.result) })
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      rotate()
      fs.appendFileSync(file, line + '\n')
    } catch {
      /* the log must never break an action; the failure is visible as a missing line */
    }
    return line
  }
  /** last n entries, newest last */
  function tail(n = 50) {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-n)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }
  return { log, tail, file }
}

module.exports = { create, redact, MAX_BYTES }
