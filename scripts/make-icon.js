'use strict'
// Draws the Jarvis logo (an arc reactor) from SVG and writes assets/icon.png (512x512, transparent) and assets/icon-256.png.
//   npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SEG = 12
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="#0d3a66"/><stop offset="0.6" stop-color="#05192f"/><stop offset="1" stop-color="#02060d"/></radialGradient>
    <radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#bff6ff"/><stop offset="0.75" stop-color="#38c8ff"/><stop offset="1" stop-color="#0b6fa8"/></radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="26"/></filter>
  </defs>
  <circle cx="512" cy="512" r="500" fill="url(#bg)"/>
  <circle cx="512" cy="512" r="494" fill="none" stroke="#38c8ff" stroke-opacity="0.55" stroke-width="8"/>
  <circle cx="512" cy="512" r="300" fill="#38c8ff" opacity="0.28" filter="url(#soft)"/>
  <g filter="url(#glow)" fill="none" stroke="#38c8ff" stroke-linecap="butt">
    <circle cx="512" cy="512" r="400" stroke-width="58" stroke-dasharray="${((2 * Math.PI * 400) / SEG) * 0.78} ${((2 * Math.PI * 400) / SEG) * 0.22}" transform="rotate(-${(360 / SEG) * 0.39} 512 512)"/>
    <circle cx="512" cy="512" r="322" stroke-width="10" stroke="#8ff0ff" stroke-opacity="0.9"/>
    <circle cx="512" cy="512" r="262" stroke-width="22" stroke-dasharray="26 18" stroke-opacity="0.75"/>
  </g>
  <g filter="url(#glow)">
    <polygon points="512,330 669.6,603 354.4,603" fill="none" stroke="#8ff0ff" stroke-width="16" stroke-linejoin="round"/>
    <circle cx="512" cy="512" r="64" fill="url(#core)"/>
  </g>
  <circle cx="512" cy="512" r="22" fill="#ffffff"/>
</svg>`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 512, height: 512, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: false } })
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 600))
  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  const img = shot.getSize().width === 512 ? shot : shot.resize({ width: 512, height: 512, quality: 'best' }) // the screen may be scaled (150 percent shows 768)
  const out = path.join(__dirname, '..', 'assets')
  fs.writeFileSync(path.join(out, 'icon.png'), img.toPNG())
  fs.writeFileSync(path.join(out, 'icon-256.png'), img.resize({ width: 256, height: 256, quality: 'best' }).toPNG())
  fs.writeFileSync(path.join(out, 'icon.svg'), svg)
  console.log('icon written', img.getSize())
  app.quit()
})
