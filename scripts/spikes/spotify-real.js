'use strict'
// Real check of the Spotify tools against the installed desktop app (plays a few seconds of one song, then pauses).
const { spawn } = require('node:child_process')
const psReal = require('../../tools/ps')
const { createSpotifyTools } = require('../../tools/spotify')
const { createRuntime } = require('../../tools/runtime')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rt = createRuntime({ audit: { log() {} }, confirm: async () => true })
for (const t of createSpotifyTools({ ps: (s, a) => psReal.run(s, a), shell: { openExternal: async (u) => { if (!/^spotify:[A-Za-z0-9:%._~!*'()-]+$/.test(u)) throw new Error('refused'); spawn('cmd', ['/c', 'start', '', u], { windowsHide: true, stdio: 'ignore' }) } } })) rt.register(t)
;(async () => {
  console.log('before :', (await rt.call('spotify_now_playing', {})).spoken)
  console.log('play   :', (await rt.call('spotify_play', { link: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT' })).spoken)
  for (let i = 0; i < 12; i++) { await sleep(2500); const r = await rt.call('spotify_now_playing', {}); console.log(`t+${(i + 1) * 2.5}s :`, r.spoken, JSON.stringify(r.data)); if (r.data && r.data.playing) break }
  const KEYS = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, int f, int e); }'; [K]::keybd_event(0xB3,0,0,0); [K]::keybd_event(0xB3,0,2,0)`
  await sleep(4000)
  await psReal.run(KEYS)
  await sleep(1500)
  console.log('paused :', (await rt.call('spotify_now_playing', {})).spoken)
})()
