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

/** PowerShell wraps error text from -EncodedCommand in CLIXML; turn it back into plain lines */
function plainErrors(text) {
  if (!String(text).startsWith('#< CLIXML')) return String(text)
  const parts = [...String(text).matchAll(/<S S="[A-Za-z]+">([\s\S]*?)<\/S>/g)].map((m) => m[1].replace(/_x([0-9A-Fa-f]{4})_/g, (x, h) => String.fromCharCode(parseInt(h, 16))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'))
  return parts.join('').replace(/^\$ProgressPreference[^\n]*\n/, '').trim()
}

/**
 * Run an arbitrary command line (Power mode only) and report everything: exit code, output, errors, whether it was stopped for taking too long.
 * It runs as the normal user, never elevated, without a window.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
function exec(command, { timeoutMs = 30_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const encoded = Buffer.from('$ProgressPreference = "SilentlyContinue"\n' + command, 'utf16le').toString('base64')
    let child
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: String((e && e.message) || e), timedOut: false })
    }
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUT) out += d
    })
    child.stderr.on('data', (d) => {
      if (err.length < MAX_OUT) err += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, stdout: out, stderr: String((e && e.message) || e), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: out, stderr: plainErrors(err), timedOut })
    })
  })
}

module.exports = { run, exec, plainErrors }
