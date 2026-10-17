# Builds the Windows installer while avoiding electron-builder's "extract to .tmp then rename" step,
# which fails with EPERM when antivirus real-time scanning locks the freshly extracted files.
#   1) uses the Electron already unpacked in node_modules (electronDist)
#   2) extracts the NSIS toolsets itself (7za from electron-builder's cache) and points builder at them
# Usage: npm run dist:local
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# no bundling step: the app runs straight from source

$cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
$tools = Join-Path $env:LOCALAPPDATA 'lyra-build-tools'
New-Item -ItemType Directory -Force $tools | Out-Null

function Ensure-Extracted($name, $archiveGlob, $dest) {
  if (Test-Path (Join-Path $dest '*')) { return }
  $archive = Get-ChildItem $cache -Recurse -Filter $archiveGlob -ErrorAction SilentlyContinue | Select-Object -First 1
  $sevenZip = Get-ChildItem $cache -Recurse -Filter '7za.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $archive -or -not $sevenZip) {
    Write-Host "First run: letting electron-builder download $name (it may fail at the rename step, which is expected)..."
    npx electron-builder --win nsis "-c.electronDist=node_modules/electron/dist" 2>$null | Out-Null
    $archive = Get-ChildItem $cache -Recurse -Filter $archiveGlob -ErrorAction SilentlyContinue | Select-Object -First 1
    $sevenZip = Get-ChildItem $cache -Recurse -Filter '7za.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $archive -or -not $sevenZip) { throw "Could not find the $name archive in $cache" }
  & $sevenZip.FullName x -y "-o$dest" $archive.FullName | Out-Null
}

$nsis = Join-Path $tools 'nsis'
$res = Join-Path $tools 'nsis-resources'
Ensure-Extracted 'NSIS' 'nsis-3.0.4.1.7z' $nsis
Ensure-Extracted 'NSIS resources' 'nsis-resources-3.4.1.7z' $res

$env:ELECTRON_BUILDER_NSIS_DIR = $nsis
$env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR = $res
$ver = (Get-Content (Join-Path $root 'node_modules\electron\package.json') | ConvertFrom-Json).version

Remove-Item -Recurse -Force (Join-Path $root 'release') -ErrorAction SilentlyContinue
npx electron-builder --win nsis "-c.electronDist=node_modules/electron/dist" "-c.electronVersion=$ver"
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
Write-Host "Installer: $(Join-Path $root 'release')"
