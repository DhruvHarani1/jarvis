'use strict'
/**
 * Launch at login, per-user (HKCU Run key). Writes the entry, then reads it back to verify, and repairs it
 * when the install folder moved or something removed it. No admin rights needed.
 */
const { execFile } = require('node:child_process')

const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
const VALUE = 'Jarvis'

const command = (exe) => `"${exe}" --autostart`

/** `reg query KEY /v NAME` output → the REG_SZ data, or null */
function parseValue(out, name = VALUE) {
  const re = new RegExp(String.raw`^\s*${name}\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$`, 'im')
  const m = re.exec(out || '')
  return m ? m[1] : null
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }))
  })
}

/**
 * Make the Run key match `enable`. Resolves to {ok, changed, state} where state is 'on' | 'off'.
 * @param {{enable:boolean, exe:string, key?:string, name?:string}} o
 */
async function sync({ enable, exe, key = RUN_KEY, name = VALUE }) {
  const want = command(exe)
  const cur = await reg(['query', key, '/v', name])
  const have = cur.ok ? parseValue(cur.out, name) : null
  if (enable) {
    if (have === want) return { ok: true, changed: false, state: 'on' }
    const w = await reg(['add', key, '/v', name, '/t', 'REG_SZ', '/d', want, '/f'])
    if (!w.ok) return { ok: false, changed: false, state: 'off', error: w.err }
    const check = await reg(['query', key, '/v', name])
    const ok = check.ok && parseValue(check.out, name) === want
    return { ok, changed: true, state: ok ? 'on' : 'off', error: ok ? undefined : 'could not verify the startup entry' }
  }
  if (have === null) return { ok: true, changed: false, state: 'off' }
  const d = await reg(['delete', key, '/v', name, '/f'])
  return { ok: d.ok, changed: d.ok, state: d.ok ? 'off' : 'on', error: d.ok ? undefined : d.err }
}

module.exports = { sync, parseValue, command, RUN_KEY, VALUE }
