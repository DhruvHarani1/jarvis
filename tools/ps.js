'use strict'
/**
 * Runs a FIXED PowerShell script. Scripts are constants in this codebase; the only thing that varies is the argument,
 * which travels as base64 JSON in an environment variable and is read with ConvertFrom-Json. Nothing a user or a model
 * says is ever pasted into a script or a command line.
 */
const { spawn } = require('node:child_process')

const MAX_OUT = 200_000

/**
 * @param {string} script
 * @param {any} [arg] JSON-serialisable
 * @param {{timeoutMs?:number, spawnFn?:Function}} [o]
 * @returns {Promise<string>} stdout
 */
function run(script, arg, { timeoutMs = 15_000, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from('$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"; $arg = if ($env:JARVIS_ARG) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:JARVIS_ARG)) | ConvertFrom-Json } else { $null }\ntry {\n' + script + '\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }', 'utf16le').toString('base64')
    let child
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, JARVIS_ARG: arg === undefined ? '' : Buffer.from(JSON.stringify(arg), 'utf8').toString('base64') }
      })
    } catch (e) {
      return reject(e)
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
      reject(new Error('that took too long'))
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUT) out += d
    })
    child.stderr.on('data', (d) => {
      if (err.length < 4000) err += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error((err.split(/\r?\n/).find((l) => l.trim()) || `PowerShell failed (${code})`).slice(0, 300)))
    })
  })
}

module.exports = { run }
