# Builds the test fixtures in scratch/ (not committed): wake-phrase WAVs and the fake microphone recording.
$root = Split-Path -Parent $PSScriptRoot
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scratch\make-wake-wavs.ps1') -OutDir (Join-Path $root 'scratch\wake-wavs')
Add-Type -AssemblyName System.Speech
$say = Join-Path $root 'scratch\say.wav'
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile($say)
$s.Speak('what is the weather like today')
$s.Dispose()
node (Join-Path $root 'scripts\make-fake-mic.js') $say (Join-Path $root 'scratch\fake-mic.wav')
