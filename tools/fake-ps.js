'use strict'
/**
 * A stand-in for tools/ps.js used by the tests of the real app: it answers the way Windows would for harmless things and
 * records every call, so a test can drive "open Spotify" or "delete this file" without touching the real PC.
 */
const fs = require('node:fs')
const { PS } = require('./windows')

const APPS = [
  { name: 'Spotify', id: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { name: 'Microsoft Teams', id: 'MSTeams_8wekyb3d8bbwe!MSTeams' },
  { name: 'Notepad', id: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }
]

/** @param {{logFile?:string}} [o] */
function create({ logFile } = {}) {
  let volume = { level: 40, muted: false }
  const calls = []
  async function ps(script, arg) {
    const which = Object.keys(PS).find((k) => PS[k] === script) || 'unknown'
    calls.push({ which, arg })
    if (logFile) fs.appendFileSync(logFile, JSON.stringify({ which, arg }) + '\n')
    if (which === 'startApps') return JSON.stringify(APPS)
    if (which === 'audioGet') return JSON.stringify(volume)
    if (which === 'audioSet') return JSON.stringify((volume = { ...volume, level: arg.level }))
    if (which === 'audioMute') return JSON.stringify((volume = { ...volume, muted: arg.muted }))
    if (which === 'cpuBattery') return JSON.stringify({ cpu: 7, battery: 64, charging: false })
    if (which === 'recycle') {
      // really move the file away so the test sees it gone, but only into the recycle stand-in beside it
      fs.renameSync(arg.path, arg.path + '.recycled')
      return 'ok'
    }
    if (which === 'restore') {
      fs.renameSync(arg.path + '.recycled', arg.path)
      return 'ok'
    }
    return 'ok'
  }
  return { ps, calls, get volume() { return volume } }
}

module.exports = { create }
