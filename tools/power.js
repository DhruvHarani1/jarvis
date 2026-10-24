'use strict'
/**
 * Power mode: the tools that can do anything a user could do at the keyboard. They are tier T3: invisible to the AI model
 * until the user switches Power mode on in the tray (it switches itself off again every time Jarvis starts), and every single
 * call needs a CLICK on the confirmation box that shows the exact command, whatever the model or a spoken "yes" says.
 *
 * run_powershell   any PowerShell command, as the normal user (never elevated), with a time limit
 * type_into_app    bring an app to the front and type text into it, but only if that app really is in front
 * ui_click         press a named button or menu item in an app through Windows UI Automation
 *
 * The block list below is a safety net against the worst accidents (wiping disks, switching off Defender, reading Jarvis's own
 * stored keys); it is NOT a security boundary, because a determined command can be written around any pattern. The real control
 * is that you read the command and click Allow.
 */
const BLOCKED = [
  [/\bFormat-Volume\b|\bClear-Disk\b|\bRemove-Partition\b|\bInitialize-Disk\b|\bdiskpart\b|\bcipher(\.exe)?\s+\/w\b|(^|[\s;&|])format(\.com)?\s+[a-z]:|\bbcdedit\b|\bvssadmin(\.exe)?\s+delete\b|\bwbadmin(\.exe)?\s+delete\b/i, 'it could wipe or damage a disk'],
  [/\breg(\.exe)?\s+delete\s+["']?HK(LM|EY_LOCAL_MACHINE)|Remove-Item(?=[^\n]*-Recurse)[^\n]*[A-Za-z]:\\(Windows|Program Files)/i, 'it could damage Windows or installed programs'],
  [/\bSet-MpPreference\b|\bAdd-MpPreference\b|DisableRealtimeMonitoring|Stop-Service[^\n]*(WinDefend|Sense|mpssvc)|netsh(\.exe)?\s+advfirewall[^\n]*(off|state)|Disable-NetFirewallRule|\bsc(\.exe)?\s+(stop|config)\s+(WinDefend|mpssvc)/i, 'it would switch off Windows security'],
  [/\bmimikatz\b|\bsekurlsa\b|\blsass\b|\bvaultcmd\b|cmdkey(\.exe)?\s+\/list|Get-StoredCredential/i, 'it goes after stored passwords'],
  [/-Verb\s+RunAs\b|\brunas(\.exe)?\s/i, 'Jarvis never runs anything as administrator'],
  [/(\biex\b|\bInvoke-Expression\b)[^\n]*(\biwr\b|Invoke-WebRequest|DownloadString|Net\.WebClient|\bcurl\b|\bwget\b)|(\biwr\b|Invoke-WebRequest|DownloadString|Net\.WebClient|\bcurl\b|\bwget\b)[^\n]*\|\s*(iex|Invoke-Expression)\b/i, 'it would download code and run it unseen'],
  [/-enc(odedcommand)?\s+[A-Za-z0-9+/=]{20,}/i, 'it hides what it runs']
]
const OWN_FILES = /(brain|accounts|quota|reminders)\.json|jarvis\.db|activity\.jsonl|jarvis-memory-export|\\jarvis\\(Local State|Network|Cookies)/i

/** @returns {string} why it is refused, or '' when it may go to the confirmation box */
function blockedReason(command, protectedPaths = []) {
  const c = String(command || '')
  for (const [re, why] of BLOCKED) if (re.test(c)) return why
  if (OWN_FILES.test(c)) return 'it reads Jarvis’s own stored keys and data'
  for (const p of protectedPaths) if (p && c.toLowerCase().includes(String(p).toLowerCase())) return 'it touches Jarvis’s own data folder'
  return ''
}

/** SendKeys treats + ^ % ~ ( ) { } [ ] as commands; typed text must have them escaped */
function escapeSendKeys(text) {
  return String(text)
    .replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`)
    .replace(/\r?\n/g, '{ENTER}')
    .replace(/\t/g, '{TAB}')
}

const PS_TYPE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class JarvisFg2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
'@
function Get-Fg { $h = [JarvisFg2]::GetForegroundWindow(); $p = 0; [void][JarvisFg2]::GetWindowThreadProcessId($h, [ref]$p); try { (Get-Process -Id $p).ProcessName } catch { '' } }
$want = [string]$arg.app
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -ieq $want -or $_.MainWindowTitle -ilike ('*' + $want + '*')) } | Select-Object -First 1
if (-not $proc) { throw ('I cannot see a window for ' + $want + '. Is it open?') }
[Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id)
Start-Sleep -Milliseconds 700
$fg = Get-Fg
$matched = ($fg -ieq $proc.ProcessName)
$sent = $false
if ($matched) { [System.Windows.Forms.SendKeys]::SendWait([string]$arg.keys); $sent = $true }
[pscustomobject]@{ target = $proc.ProcessName; foreground = $fg; matched = $matched; sent = $sent } | ConvertTo-Json -Compress`

const PS_CLICK = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$want = [string]$arg.app
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -ieq $want -or $_.MainWindowTitle -ilike ('*' + $want + '*')) } | Select-Object -First 1
if (-not $proc) { throw ('I cannot see a window for ' + $want + '. Is it open?') }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, [string]$arg.element)
$els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
if ($els.Count -eq 0) { throw ('I cannot find "' + $arg.element + '" in ' + $proc.ProcessName) }
$done = $false
foreach ($el in $els) {
  foreach ($p in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern, [System.Windows.Automation.ExpandCollapsePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern)) {
    $pat = $null
    if ($el.TryGetCurrentPattern($p, [ref]$pat)) {
      if ($p -eq [System.Windows.Automation.InvokePattern]::Pattern) { $pat.Invoke() }
      elseif ($p -eq [System.Windows.Automation.TogglePattern]::Pattern) { $pat.Toggle() }
      elseif ($p -eq [System.Windows.Automation.ExpandCollapsePattern]::Pattern) { $pat.Expand() }
      else { $pat.Select() }
      $done = $true
      break
    }
  }
  if ($done) { break }
}
if (-not $done) {
  # no pattern to call: click where it is, but only if that exact spot belongs to this app right now
  Add-Type -AssemblyName Microsoft.VisualBasic
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class JarvisMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
}
'@
  [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id)
  Start-Sleep -Milliseconds 500
  foreach ($el in $els) {
    $r = $el.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -lt 2) { continue }
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    $at = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y)))
    if ($at -and $at.Current.ProcessId -eq $proc.Id) {
      [void][JarvisMouse]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 80
      [JarvisMouse]::mouse_event(2, 0, 0, 0, 0); [JarvisMouse]::mouse_event(4, 0, 0, 0, 0)
      $done = $true
      break
    }
  }
}
if (-not $done) { throw ('"' + $arg.element + '" cannot be pressed: it has no UI Automation action and is not visible on top') }
[pscustomobject]@{ target = $proc.ProcessName; clicked = $true } | ConvertTo-Json -Compress`

const obj = (properties, required = []) => ({ type: 'object', properties, required })
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + `… (+${String(s).length - n} more characters)` : String(s))

/** @param {{exec:(c:string,o?:any)=>Promise<{code:number|null,stdout:string,stderr:string,timedOut:boolean}>, ps:(s:string,a?:any)=>Promise<string>, protectedPaths?:string[]}} d */
function createPowerTools(d) {
  const T = []

  T.push({
    name: 'run_powershell',
    tier: 'T3',
    title: 'Run a PowerShell command',
    description: 'POWER MODE. Run one PowerShell command line on the user’s PC (as the normal user, 30 second limit) and return its output. The user reads the exact command and must click Allow every time. Prefer the dedicated tools when one exists.',
    schema: obj({ command: { type: 'string', minLength: 2, maxLength: 2000 } }, ['command']),
    describe: (a) => `Run this PowerShell command on your PC:\n\n${a.command}\n\nIt runs as you (not as administrator), stops after 30 seconds, and cannot be undone.${blockedReason(a.command, d.protectedPaths) ? '\n\nREFUSED: ' + blockedReason(a.command, d.protectedPaths) : ''}`,
    run: async ({ command }) => {
      const why = blockedReason(command, d.protectedPaths)
      if (why) throw new Error(`I will not run that: ${why}`)
      const r = await d.exec(command, { timeoutMs: 30_000 })
      const out = clip(r.stdout.trim(), 3000)
      const err = clip(r.stderr.trim(), 1000)
      if (r.timedOut) return { spoken: 'It took more than 30 seconds, so I stopped it.', data: { code: r.code, stdout: out, stderr: err, timedOut: true }, untrusted: true }
      const ok = r.code === 0
      const head = ok ? 'Done.' : `It failed with code ${r.code}.`
      return { spoken: `${head}${out ? ' ' + clip(out.replace(/\s+/g, ' '), 240) : ''}${!ok && err ? ' ' + clip(err.replace(/\s+/g, ' '), 160) : ''}`, data: { code: r.code, stdout: out, stderr: err }, untrusted: true }
    }
  })

  T.push({
    name: 'type_into_app',
    tier: 'T3',
    title: 'Type into an app',
    description: 'POWER MODE. Bring an open app to the front and type text into it as if the user typed it, optionally pressing Enter. Only types if that app really is in front. The user must click Allow every time.',
    schema: obj({ app: { type: 'string', minLength: 1, maxLength: 60 }, text: { type: 'string', minLength: 1, maxLength: 300 }, enter: { type: 'boolean' } }, ['app', 'text']),
    describe: (a) => `Type into ${a.app}:\n\n${a.text}${a.enter ? '\n\n(then press Enter)' : ''}\n\nIt goes into whatever has the cursor in that app. This cannot be undone.`,
    run: async ({ app, text, enter }) => {
      const keys = escapeSendKeys(text) + (enter ? '{ENTER}' : '')
      const r = JSON.parse(await d.ps(PS_TYPE, { app, keys }))
      return r.sent ? { spoken: `Typed it into ${r.target}.`, data: r } : { spoken: `${r.target} would not come to the front (${r.foreground || 'something else'} was in front), so I typed nothing.`, data: r }
    }
  })

  T.push({
    name: 'ui_click',
    tier: 'T3',
    title: 'Press a button in an app',
    description: 'POWER MODE. Press a button, menu item or checkbox by its visible name in an open app, using Windows UI Automation. The user must click Allow every time.',
    schema: obj({ app: { type: 'string', minLength: 1, maxLength: 60 }, element: { type: 'string', minLength: 1, maxLength: 80 } }, ['app', 'element']),
    describe: (a) => `Press "${a.element}" in ${a.app}.\n\nThis cannot be undone.`,
    run: async ({ app, element }) => {
      const r = JSON.parse(await d.ps(PS_CLICK, { app, element }))
      return { spoken: `Pressed ${element} in ${r.target}.`, data: r }
    }
  })

  return T
}

module.exports = { createPowerTools, blockedReason, escapeSendKeys, PS_TYPE, PS_CLICK, BLOCKED }
