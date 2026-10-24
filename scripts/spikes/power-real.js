'use strict'
// Real check of Power mode automation against a window THIS SCRIPT creates (a small form with one text box), never against someone's open app:
// types into it, reads it back, presses a button through UI Automation, and closes it.
const { spawn } = require('node:child_process')
const psReal = require('../../tools/ps')
const { createPowerTools } = require('../../tools/power')
const { createRuntime } = require('../../tools/runtime')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FORM = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form; $f.Text = 'JarvisPowerTest'; $f.Width = 420; $f.Height = 200; $f.TopMost = $true
$t = New-Object System.Windows.Forms.TextBox; $t.Name = 'box'; $t.Left = 10; $t.Top = 10; $t.Width = 380; $f.Controls.Add($t)
$b = New-Object System.Windows.Forms.Button; $b.Text = 'Press me'; $b.Left = 10; $b.Top = 50; $b.Add_Click({ [IO.File]::WriteAllText($env:JARVIS_FORM_OUT, 'clicked|' + $t.Text); $f.Close() }); $f.Controls.Add($b)
$f.Add_Shown({ $f.Activate(); $t.Focus() })
[void]$f.ShowDialog()`
const out = require('node:path').join(require('node:os').tmpdir(), 'jarvis-form-out.txt')
require('node:fs').rmSync(out, { force: true })
const rt = createRuntime({ audit: { log() {} }, confirm: async () => true, powerMode: () => true })
for (const t of createPowerTools({ exec: (c, o) => psReal.exec(c, o), ps: (s, a) => psReal.run(s, a, { timeoutMs: 40000 }), protectedPaths: [] })) rt.register(t)
;(async () => {
  const form = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(FORM, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: false, env: { ...process.env, JARVIS_FORM_OUT: out } })
  await sleep(3500)
  const typed = await rt.call('type_into_app', { app: 'JarvisPowerTest', text: 'Hello from Jarvis (power mode) + 5%' })
  console.log('type :', JSON.stringify(typed))
  await sleep(500)
  const click = await rt.call('ui_click', { app: 'JarvisPowerTest', element: 'Press me' })
  console.log('click:', JSON.stringify(click))
  await sleep(1500)
  console.log('form wrote:', require('node:fs').existsSync(out) ? require('node:fs').readFileSync(out, 'utf8') : '(nothing)')
  try { form.kill() } catch { /* already closed */ }
})().catch((e) => console.log('ERR', e.message))
