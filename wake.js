'use strict'
/**
 * "Hey Jarvis": an optional, always-on, fully offline wake word.
 *
 * A small PowerShell process runs Windows' own speech recogniser against a tiny grammar made of the wake phrases only, so
 * everything else you say is simply not recognised. Audio is processed live on this PC, never recorded, never sent anywhere.
 * (Windows shows its microphone-in-use indicator for as long as this is on, and the app shows a blue ear on the badge.)
 *
 * Protocol (one line each way):  stdout  READY | WAKE <confidence> | FAILED <reason>      stdin  P pause | R resume | Q quit
 */
const { spawn: realSpawn } = require('node:child_process')

const PHRASES = ['hey jarvis', 'okay jarvis']

const SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
  '$phr = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SPIDEY_WAKE_PHRASES)) | ConvertFrom-Json',
  '$c = New-Object System.Speech.Recognition.Choices; foreach ($p in $phr) { $c.Add([string]$p) }',
  '$gb = New-Object System.Speech.Recognition.GrammarBuilder; $gb.Append($c)',
  '$e.LoadGrammar((New-Object System.Speech.Recognition.Grammar($gb)))',
  '$min = [double]$env:SPIDEY_WAKE_MIN',
  // a WAV file instead of the microphone is only ever used by the tests
  'try { if ($env:SPIDEY_WAKE_WAV) { $e.SetInputToWaveFile($env:SPIDEY_WAKE_WAV) } else { $e.SetInputToDefaultAudioDevice() } } catch { [Console]::Out.WriteLine("FAILED " + $_.Exception.Message); [Console]::Out.Flush(); exit 1 }',
  '$null = Register-ObjectEvent -InputObject $e -EventName SpeechRecognized -SourceIdentifier hit',
  '$e.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)',
  '$in = [Console]::OpenStandardInput(); $buf = New-Object byte[] 256; $sb = New-Object System.Text.StringBuilder; $task = $in.ReadAsync($buf, 0, $buf.Length)',
  'function NextLine { if ($task.IsCompleted) { $n = $task.Result; if ($n -le 0) { exit }; [void]$sb.Append([Text.Encoding]::ASCII.GetString($buf, 0, $n)); $script:task = $in.ReadAsync($buf, 0, $buf.Length) }; $t = $sb.ToString(); $i = $t.IndexOf([char]10); if ($i -lt 0) { return $null }; [void]$sb.Remove(0, $i + 1); return $t.Substring(0, $i).Trim() }',
  '$paused = $false',
  "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()",
  'while ($true) {',
  '  $ev = Wait-Event -SourceIdentifier hit -Timeout 0.2',
  '  if ($ev) { $r = $ev.SourceEventArgs.Result; Remove-Event -EventIdentifier $ev.EventIdentifier; if (-not $paused -and $r.Confidence -ge $min) { [Console]::Out.WriteLine(("WAKE {0:N2}" -f $r.Confidence)); [Console]::Out.Flush() } }',
  '  $line = NextLine',
  '  if ($line -eq "Q") { break }',
  '  elseif ($line -eq "P") { $paused = $true }',
  '  elseif ($line -eq "R") { $paused = $false }',
  '}',
  'try { $e.RecognizeAsyncCancel() } catch {}'
].join('\n')

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

/**
 * @param {{spawn?:Function, onWake:(confidence:number)=>void, onState?:(s:'off'|'starting'|'listening'|'failed', detail?:string)=>void,
 *          phrases?:string[], minConfidence?:number, debounceMs?:number, restartMs?:number, now?:()=>number, env?:object}} o
 */
function create(o) {
  const spawnFn = o.spawn || realSpawn
  const now = o.now || Date.now
  const debounceMs = o.debounceMs ?? 2500
  const restartMs = o.restartMs ?? 3000
  let child = null
  let wanted = false
  let paused = false
  let state = 'off'
  let lastWake = -Infinity
  let restarts = []
  let timer = null

  const set = (s, detail) => {
    state = s
    if (o.onState) o.onState(s, detail)
  }

  function launch() {
    if (!wanted || child) return
    set('starting')
    let c
    try {
      c = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ...(o.env || {}), SPIDEY_WAKE_PHRASES: b64(o.phrases || PHRASES), SPIDEY_WAKE_MIN: String(o.minConfidence ?? 0.6) }
      })
    } catch (e) {
      set('failed', e.message)
      return
    }
    child = c
    let buf = ''
    let failedReason = ''
    c.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line === 'READY') {
          set('listening')
          if (paused) write('P')
        } else if (line.startsWith('WAKE ')) {
          const t = now()
          if (t - lastWake >= debounceMs && !paused) {
            lastWake = t
            o.onWake(Number(line.slice(5)) || 0)
          }
        } else if (line.startsWith('FAILED')) failedReason = line.slice(7)
      }
    })
    c.stdin.on('error', () => {})
    c.on('error', (e) => {
      failedReason = e.message
    })
    c.on('close', () => {
      if (child === c) child = null
      if (!wanted) return set('off')
      // it died while it should be running: restart a few times, then give up and say why
      const t = now()
      restarts = restarts.filter((x) => t - x < 5 * 60_000)
      restarts.push(t)
      if (restarts.length > 4 || failedReason) {
        wanted = false
        return set('failed', failedReason || 'the recogniser keeps stopping')
      }
      timer = setTimeout(launch, restartMs)
      if (timer.unref) timer.unref()
    })
  }

  function write(line) {
    try {
      child && child.stdin.write(line + '\n')
    } catch {
      /* closing */
    }
  }

  return {
    start() {
      if (wanted) return
      wanted = true
      restarts = []
      launch()
    },
    stop() {
      wanted = false
      clearTimeout(timer)
      set('off')
      if (child) {
        write('Q')
        const c = child
        setTimeout(() => {
          try {
            c.kill()
          } catch {
            /* gone */
          }
        }, 400).unref?.()
      }
    },
    /** stop reacting (Jarvis is talking, or the microphone is in use for a real question) */
    pause() {
      if (paused) return
      paused = true
      write('P')
    },
    resume() {
      if (!paused) return
      paused = false
      write('R')
    },
    get state() {
      return state
    },
    get paused() {
      return paused
    }
  }
}

module.exports = { create, PHRASES, SCRIPT }
