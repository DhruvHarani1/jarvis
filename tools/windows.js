'use strict'
/**
 * Jarvis's hands on Windows: the built-in tools. Every tool is a plain object for tools/runtime.js (name, tier, schema, run).
 * Everything that touches the system is injected (ps, shell, clipboard, scheduler, sandbox, os), so each tool is unit-tested
 * without changing the real PC.
 */

// ------------------------------------------------------------------------------------------------ fixed PowerShell scripts
const AUDIO_TYPES = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int _0(); int _1(); int _2(); int _3(); int SetMasterVolumeLevelScalar(float f, Guid g); int _5(); int GetMasterVolumeLevelScalar(out float f); int _7(); int _8(); int _9(); int _10(); int SetMute([MarshalAs(UnmanagedType.Bool)] bool b, Guid g); int GetMute(out bool b); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, out IAudioEndpointVolume v); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int _0(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class JarvisAudio {
  static IAudioEndpointVolume Vol() { var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator; IMMDevice d; e.GetDefaultAudioEndpoint(0, 1, out d); IAudioEndpointVolume v; var g = typeof(IAudioEndpointVolume).GUID; d.Activate(ref g, 23, IntPtr.Zero, out v); return v; }
  public static int Get() { float f; Vol().GetMasterVolumeLevelScalar(out f); return (int)Math.Round(f * 100); }
  public static void Set(int p) { Vol().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, p)) / 100f, Guid.Empty); }
  public static bool GetMute() { bool b; Vol().GetMute(out b); return b; }
  public static void SetMute(bool b) { Vol().SetMute(b, Guid.Empty); }
}
'@
`
const PS = {
  audioGet: AUDIO_TYPES + '[pscustomobject]@{ level = [JarvisAudio]::Get(); muted = [JarvisAudio]::GetMute() } | ConvertTo-Json -Compress',
  audioSet: AUDIO_TYPES + '[JarvisAudio]::Set([int]$arg.level); [pscustomobject]@{ level = [JarvisAudio]::Get(); muted = [JarvisAudio]::GetMute() } | ConvertTo-Json -Compress',
  audioMute: AUDIO_TYPES + '[JarvisAudio]::SetMute([bool]$arg.muted); [pscustomobject]@{ level = [JarvisAudio]::Get(); muted = [JarvisAudio]::GetMute() } | ConvertTo-Json -Compress',
  mediaKey: `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class JarvisKeys { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra); }
'@
$vk = [byte]$arg.vk
[JarvisKeys]::keybd_event($vk, 0, 0, 0); [JarvisKeys]::keybd_event($vk, 0, 2, 0)
'ok'`,
  startApps: 'Get-StartApps | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.AppID } } | ConvertTo-Json -Compress',
  launchApp: 'Start-Process explorer.exe -ArgumentList ("shell:AppsFolder\\" + $arg.id)',
  cpuBattery: `
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
[pscustomobject]@{ cpu = [int]$cpu; battery = if ($b) { [int]$b.EstimatedChargeRemaining } else { $null }; charging = if ($b) { $b.BatteryStatus -eq 2 } else { $null } } | ConvertTo-Json -Compress`,
  recycle: `
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($arg.path, 'OnlyErrorDialogs', 'SendToRecycleBin')
'ok'`,
  restore: `
$p = [string]$arg.path
$dir = Split-Path -Parent $p
$leaf = Split-Path -Leaf $p
$base = [IO.Path]::GetFileNameWithoutExtension($leaf)
$bin = (New-Object -ComObject Shell.Application).NameSpace(10)
$hits = @()
foreach ($i in $bin.Items()) {
  $from = $bin.GetDetailsOf($i, 1)
  if ($from -eq $dir -and ($i.Name -eq $leaf -or $i.Name -eq $base)) { $hits += $i }
}
if (-not $hits.Count) { throw 'I could not find it in the Recycle Bin' }
$hits[-1].InvokeVerb('undelete')
Start-Sleep -Milliseconds 400
if (-not (Test-Path -LiteralPath $p)) { throw 'the restore did not complete' }
'ok'`
}

const MEDIA_KEYS = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2, volume_up: 0xaf, volume_down: 0xae }
const SPOKEN_KEYS = { play_pause: 'Play pause', next: 'Next track', previous: 'Previous track', stop: 'Stopped', volume_up: 'Louder', volume_down: 'Quieter' }
const FOLDERS = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']

const obj = (properties, required = []) => ({ type: 'object', properties, required })

/** best match for a spoken app name among the installed apps */
function pickApp(apps, wanted) {
  const w = wanted.toLowerCase().trim().replace(/^the\s+/, '')
  if (!w) return null
  const score = (n) => {
    const x = n.toLowerCase()
    if (x === w) return 0
    if (x.startsWith(w)) return 1
    if (x.split(/\s+/).includes(w)) return 2
    if (x.includes(w)) return 3
    return 99
  }
  const ranked = apps.map((a) => ({ a, s: score(a.name) })).filter((x) => x.s < 99).sort((p, q) => p.s - q.s || p.a.name.length - q.a.name.length)
  return ranked.length ? ranked[0].a : null
}

/** "in 10 minutes", "at 15:30" style helpers live in fastpath; tools take exact numbers */
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const fmtDur = (min) => (min >= 60 && min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : min >= 1 ? `${Math.round(min * 10) / 10} minute${min === 1 ? '' : 's'}` : `${Math.round(min * 60)} seconds`)

/**
 * @param {{ps:(script:string,arg?:any)=>Promise<string>, shell:{openExternal:(u:string)=>Promise<any>, openPath:(p:string)=>Promise<string>},
 *          clipboard:{readText:()=>string, writeText:(t:string)=>void}, scheduler:any, sandbox:{check:(p:string)=>any, roots:string[]},
 *          fs:any, os:any, folder:(name:string)=>string|null, now?:()=>number}} d
 */
function createTools(d) {
  const now = d.now || Date.now
  const json = async (script, arg) => JSON.parse(await d.ps(script, arg))
  let appCache = null

  async function apps() {
    if (!appCache || now() - appCache.at > 10 * 60_000) {
      const raw = await json(PS.startApps)
      appCache = { at: now(), list: (Array.isArray(raw) ? raw : [raw]).filter((a) => a && a.name && a.id) }
    }
    return appCache.list
  }

  const T = []

  T.push({
    name: 'open_app',
    tier: 'T1',
    description: 'Open an installed Windows app by name (for example Spotify, Notepad, Teams, Outlook, Calculator, Settings).',
    schema: obj({ name: { type: 'string', minLength: 1, maxLength: 60 } }, ['name']),
    run: async ({ name }) => {
      const app = pickApp(await apps(), name)
      if (!app) return { spoken: `I could not find an app called ${name}.`, data: { found: false } }
      await d.ps(PS.launchApp, { id: app.id })
      return { spoken: `Opening ${app.name}.`, data: { app: app.name } }
    }
  })

  T.push({
    name: 'open_url',
    tier: 'T1',
    description: 'Open a web address (https) in the default browser.',
    schema: obj({ url: { type: 'string', minLength: 8, maxLength: 500 } }, ['url']),
    run: async ({ url }) => {
      let u
      try {
        u = new URL(url)
      } catch {
        throw new Error('that is not a web address')
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only web addresses can be opened')
      if (u.username || u.password) throw new Error('addresses with a login in them are not opened')
      await d.shell.openExternal(u.href)
      return { spoken: `Opening ${u.hostname.replace(/^www\./, '')}.` }
    }
  })

  T.push({
    name: 'set_volume',
    tier: 'T1',
    description: 'Set the system volume from 0 to 100.',
    schema: obj({ level: { type: 'integer', minimum: 0, maximum: 100 } }, ['level']),
    run: async ({ level }) => {
      const before = await json(PS.audioGet)
      const after = await json(PS.audioSet, { level })
      return {
        spoken: `Volume ${after.level}.`,
        data: after,
        undoLabel: `volume ${after.level}`,
        undo: async () => {
          await json(PS.audioSet, { level: before.level })
          return { spoken: `Volume back to ${before.level}.` }
        }
      }
    }
  })

  T.push({
    name: 'mute',
    tier: 'T1',
    description: 'Mute or unmute the system sound.',
    schema: obj({ muted: { type: 'boolean' } }, ['muted']),
    run: async ({ muted }) => {
      const before = await json(PS.audioGet)
      const after = await json(PS.audioMute, { muted })
      return {
        spoken: after.muted ? 'Muted.' : 'Unmuted.',
        data: after,
        undoLabel: after.muted ? 'mute' : 'unmute',
        undo: async () => {
          await json(PS.audioMute, { muted: before.muted })
          return { spoken: before.muted ? 'Muted again.' : 'Sound back on.' }
        }
      }
    }
  })

  T.push({
    name: 'media_key',
    tier: 'T1',
    description: 'Press a media key: play_pause, next, previous, stop, volume_up, volume_down. Controls Spotify, YouTube and any media player.',
    schema: obj({ action: { type: 'string', enum: Object.keys(MEDIA_KEYS) }, times: { type: 'integer', minimum: 1, maximum: 10 } }, ['action']),
    run: async ({ action, times = 1 }) => {
      for (let i = 0; i < times; i++) await d.ps(PS.mediaKey, { vk: MEDIA_KEYS[action] })
      return { spoken: SPOKEN_KEYS[action] + '.' }
    }
  })

  T.push({
    name: 'set_timer',
    tier: 'T1',
    description: 'Start a timer. Jarvis speaks when it ends.',
    schema: obj({ minutes: { type: 'number', minimum: 0.1, maximum: 1440 }, label: { type: 'string', maxLength: 60 } }, ['minutes']),
    run: async ({ minutes, label }) => {
      const r = d.scheduler.add({ at: now() + minutes * 60_000, text: label ? `Your ${label} timer is up.` : `Your ${fmtDur(minutes)} timer is up.` })
      if (!r.ok) throw new Error(r.error)
      return { spoken: `Timer set for ${fmtDur(minutes)}.`, data: { id: r.id }, undoLabel: 'timer', undo: async () => (d.scheduler.cancel(r.id), { spoken: 'Timer cancelled.' }) }
    }
  })

  T.push({
    name: 'add_reminder',
    tier: 'T1',
    description: 'Remind the user of something, either in a number of minutes or at an exact local date and time (ISO 8601, for example 2026-10-25T09:30).',
    schema: obj({ text: { type: 'string', minLength: 1, maxLength: 200 }, in_minutes: { type: 'number', minimum: 0.1, maximum: 525600 }, at: { type: 'string', maxLength: 40 } }, ['text']),
    run: async ({ text, in_minutes, at }) => {
      let when
      if (in_minutes !== undefined) when = now() + in_minutes * 60_000
      else if (at) {
        when = new Date(at).getTime()
        if (!Number.isFinite(when)) throw new Error('I could not understand that date and time')
      } else throw new Error('say when: in how many minutes, or at what time')
      const r = d.scheduler.add({ at: when, text })
      if (!r.ok) throw new Error(r.error)
      return { spoken: `I will remind you at ${fmtTime(when)}.`, data: { id: r.id, at: when }, undoLabel: 'reminder', undo: async () => (d.scheduler.cancel(r.id), { spoken: 'Reminder cancelled.' }) }
    }
  })

  T.push({
    name: 'list_reminders',
    tier: 'T0',
    description: 'List the pending reminders and timers.',
    schema: obj({}),
    run: async () => {
      const l = d.scheduler.list()
      return { spoken: l.length ? l.slice(0, 5).map((r) => `${r.text} at ${fmtTime(r.at)}`).join('. ') + '.' : 'You have no reminders.', data: l }
    }
  })

  T.push({
    name: 'cancel_reminder',
    tier: 'T1',
    description: 'Cancel a reminder or timer by its id (see list_reminders).',
    schema: obj({ id: { type: 'integer', minimum: 1, maximum: 1e9 } }, ['id']),
    run: async ({ id }) => ({ spoken: d.scheduler.cancel(id) ? 'Cancelled.' : 'I could not find that reminder.' })
  })

  T.push({
    name: 'read_clipboard',
    tier: 'T0',
    description: 'Read the text currently on the clipboard.',
    schema: obj({}),
    run: async () => {
      const t = String(d.clipboard.readText() || '').slice(0, 4000)
      return { spoken: t ? undefined : 'The clipboard is empty.', data: { text: t }, untrusted: true }
    }
  })

  T.push({
    name: 'write_clipboard',
    tier: 'T1',
    description: 'Put text on the clipboard.',
    schema: obj({ text: { type: 'string', minLength: 1, maxLength: 4000 } }, ['text']),
    run: async ({ text }) => {
      const before = d.clipboard.readText()
      d.clipboard.writeText(text)
      return { spoken: 'Copied.', undoLabel: 'clipboard change', undo: async () => (d.clipboard.writeText(before), { spoken: 'Clipboard restored.' }) }
    }
  })

  T.push({
    name: 'system_status',
    tier: 'T0',
    description: 'Report CPU load, memory use, battery and how long the PC has been on.',
    schema: obj({}),
    run: async () => {
      const s = await json(PS.cpuBattery)
      const total = d.os.totalmem()
      const ram = Math.round(((total - d.os.freemem()) / total) * 100)
      const hours = Math.floor(d.os.uptime() / 3600)
      const parts = [`CPU ${s.cpu} percent`, `memory ${ram} percent`]
      if (s.battery !== null && s.battery !== undefined) parts.push(`battery ${s.battery} percent${s.charging ? ', charging' : ''}`)
      parts.push(`up for ${hours} hour${hours === 1 ? '' : 's'}`)
      return { spoken: parts.join(', ') + '.', data: { cpu: s.cpu, ramPercent: ram, battery: s.battery, charging: s.charging, uptimeHours: hours } }
    }
  })

  T.push({
    name: 'find_files',
    tier: 'T0',
    description: 'Find files by part of their name in the Desktop, Documents, Downloads, Pictures, Music or Videos folder (all of them if folder is omitted). Returns full paths.',
    schema: obj({ query: { type: 'string', minLength: 1, maxLength: 80 }, folder: { type: 'string', enum: FOLDERS }, max: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']),
    run: async ({ query, folder, max = 8 }) => {
      const roots = folder ? [d.folder(folder)].filter(Boolean) : d.sandbox.roots
      const q = query.toLowerCase()
      const found = []
      let visited = 0
      const walk = (dir, depth) => {
        if (found.length >= max || depth > 5 || visited > 20000) return
        let entries
        try {
          entries = d.fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (found.length >= max) return
          visited++
          const full = dir + '\\' + e.name
          if (e.isSymbolicLink()) continue
          if (e.name.toLowerCase().includes(q)) found.push({ path: full, folder: e.isDirectory() })
          if (e.isDirectory() && !e.name.startsWith('.')) walk(full, depth + 1)
        }
      }
      for (const r of roots) walk(r, 0)
      return {
        spoken: found.length ? `I found ${found.length}: ${found.slice(0, 3).map((f) => f.path.split('\\').pop()).join(', ')}.` : `I found nothing called ${query}.`,
        data: found,
        untrusted: found.length > 0 // file names can be written by anyone who sent you a file
      }
    }
  })

  T.push({
    name: 'open_file',
    tier: 'T1',
    description: 'Open a file or folder (full path inside Desktop, Documents, Downloads, Pictures, Music or Videos) with its default app.',
    schema: obj({ path: { type: 'string', minLength: 3, maxLength: 400 } }, ['path']),
    run: async ({ path: p }) => {
      const c = d.sandbox.check(p)
      if (!c.ok) throw new Error(c.error)
      if (!d.fs.existsSync(c.path)) throw new Error('that file does not exist')
      if (/\.(exe|msi|bat|cmd|ps1|vbs|js|jse|wsf|scr|com|lnk|reg|hta|cpl|dll)$/i.test(c.path)) throw new Error('I do not open programs or scripts from files; ask me to open the app instead')
      const err = await d.shell.openPath(c.path)
      if (err) throw new Error(err)
      return { spoken: 'Opening it.' }
    }
  })

  T.push({
    name: 'move_file',
    tier: 'T2',
    title: 'Move a file',
    description: 'Move or rename a file. Both paths must be inside Desktop, Documents, Downloads, Pictures, Music or Videos. Never overwrites.',
    schema: obj({ from: { type: 'string', minLength: 3, maxLength: 400 }, to: { type: 'string', minLength: 3, maxLength: 400 } }, ['from', 'to']),
    describe: (a) => `Move\n${a.from}\nto\n${a.to}`,
    run: async ({ from, to }) => {
      const a = d.sandbox.check(from)
      const b = d.sandbox.check(to)
      if (!a.ok) throw new Error(a.error)
      if (!b.ok) throw new Error(b.error)
      if (!d.fs.existsSync(a.path)) throw new Error('the file does not exist')
      if (d.fs.statSync(a.path).isDirectory()) throw new Error('I only move files, not folders')
      if (d.fs.existsSync(b.path)) throw new Error('something is already there; I will not overwrite it')
      d.fs.mkdirSync(require('node:path').dirname(b.path), { recursive: true })
      d.fs.renameSync(a.path, b.path)
      return {
        spoken: 'Moved.',
        data: { from: a.path, to: b.path },
        undoLabel: 'file move',
        undo: async () => {
          if (d.fs.existsSync(a.path)) throw new Error('the original place is taken now')
          d.fs.renameSync(b.path, a.path)
          return { spoken: 'Moved back.' }
        }
      }
    }
  })

  T.push({
    name: 'delete_file',
    tier: 'T2',
    title: 'Delete a file',
    description: 'Send a file to the Recycle Bin (it can be restored). Path must be inside Desktop, Documents, Downloads, Pictures, Music or Videos. Files only.',
    schema: obj({ path: { type: 'string', minLength: 3, maxLength: 400 } }, ['path']),
    describe: (a) => `Move to the Recycle Bin:\n${a.path}`,
    run: async ({ path: p }) => {
      const c = d.sandbox.check(p)
      if (!c.ok) throw new Error(c.error)
      if (!d.fs.existsSync(c.path)) throw new Error('that file does not exist')
      if (d.fs.statSync(c.path).isDirectory()) throw new Error('I only delete single files, not folders')
      if (d.sandbox.roots.some((r) => r.toLowerCase() === c.path.toLowerCase())) throw new Error('that is one of my protected folders')
      await d.ps(PS.recycle, { path: c.path })
      return {
        spoken: 'It is in the Recycle Bin.',
        data: { path: c.path },
        undoLabel: 'file deletion',
        undo: async () => {
          await d.ps(PS.restore, { path: c.path })
          return { spoken: 'Restored.' }
        }
      }
    }
  })

  return T
}

module.exports = { createTools, pickApp, PS, MEDIA_KEYS, FOLDERS }
