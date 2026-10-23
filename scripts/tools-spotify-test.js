'use strict'
// Unit tests for tools/spotify.js: links are validated strictly, only spotify: URIs are ever opened, titles are parsed.
const assert = require('node:assert/strict')
const { createSpotifyTools, parseLink, parseTitle, cleanQuery } = require('../tools/spotify')
const { createRuntime } = require('../tools/runtime')

const ID = '4cOdK2wGLETKBW3PvgPWqT'

// ---- links
assert.deepEqual(parseLink(`spotify:track:${ID}`), { kind: 'track', id: ID, uri: `spotify:track:${ID}` })
assert.deepEqual(parseLink(`https://open.spotify.com/track/${ID}?si=abc123`), { kind: 'track', id: ID, uri: `spotify:track:${ID}` })
assert.deepEqual(parseLink(`https://open.spotify.com/intl-de/album/${ID}`).kind, 'album')
assert.equal(parseLink(`  spotify:playlist:${ID}  `).kind, 'playlist')
for (const bad of [
  '', null, 'spotify:track:short', `spotify:user:${ID}`, `spotify:track:${ID}x`, `spotify:track:${ID}:play`, `spotify:track:${ID} && calc.exe`,
  `http://open.spotify.com/track/${ID}`, `https://open.spotify.com.evil.example/track/${ID}`, `https://evil.example/https://open.spotify.com/track/${ID}`,
  `https://open.spotify.com/track/${ID}/../../x`.replace('/track/', '/podcast/'), `javascript:alert(1)`, `file:///C:/Windows/System32/calc.exe`
]) assert.equal(parseLink(bad), null, String(bad))

// ---- titles
assert.deepEqual(parseTitle('Rick Astley - Never Gonna Give You Up'), { artist: 'Rick Astley', title: 'Never Gonna Give You Up' })
assert.deepEqual(parseTitle('AC/DC - Back In Black - Remastered'), { artist: 'AC/DC', title: 'Back In Black - Remastered' })
assert.deepEqual(parseTitle('Only A Title'), { artist: '', title: 'Only A Title' })
for (const idle of ['', 'Spotify', 'Spotify Free', 'spotify premium', '   ', null]) assert.equal(parseTitle(idle), null, String(idle))

// ---- query cleaning
assert.equal(cleanQuery('  despacito\n\n  luis   fonsi\u0000 '), 'despacito luis fonsi')
assert.equal(cleanQuery('x'.repeat(300)).length, 100)

;(async () => {
  const opened = []
  let title = { running: true, title: 'Daft Punk - Get Lucky' }
  const rt = createRuntime({ audit: { log() {} }, confirm: async () => true })
  for (const t of createSpotifyTools({ ps: async () => JSON.stringify(title), shell: { openExternal: async (u) => opened.push(u) } })) rt.register(t)
  const tiers = Object.fromEntries(rt.tiers().map((t) => [t.name, t.tier]))
  assert.deepEqual(tiers, { spotify_now_playing: 'T0', spotify_search: 'T1', spotify_play: 'T1', spotify_open_liked_songs: 'T1' })

  // now playing: flagged as untrusted text, handles closed / idle
  let r = await rt.call('spotify_now_playing', {})
  assert.deepEqual([r.ok, r.spoken, r.untrusted], [true, 'Get Lucky by Daft Punk.', true])
  title = { running: true, title: 'Spotify Free' }
  r = await rt.call('spotify_now_playing', {})
  assert.deepEqual([r.spoken, r.untrusted], ['Nothing is playing in Spotify right now.', false])
  title = { running: false, title: '' }
  assert.equal((await rt.call('spotify_now_playing', {})).spoken, 'Spotify is not open.')

  // search: the query is encoded into one fixed link shape
  r = await rt.call('spotify_search', { query: 'Despacito & friends/../x' })
  assert.ok(r.ok)
  assert.equal(opened.at(-1), 'spotify:search:Despacito%20%26%20friends%2F..%2Fx')
  assert.ok(/^spotify:search:[A-Za-z0-9%._~!*'()-]*$/.test(opened.at(-1)), 'nothing but a URI-safe query follows spotify:search:')
  assert.match(r.spoken, /press play/i)
  assert.equal((await rt.call('spotify_search', { query: '   ' })).ok, false)

  // play: tracks, albums, playlists, episodes start; artists and shows only open
  await rt.call('spotify_play', { link: `https://open.spotify.com/track/${ID}?si=x` })
  assert.equal(opened.at(-1), `spotify:track:${ID}:play`)
  await rt.call('spotify_play', { link: `spotify:playlist:${ID}` })
  assert.equal(opened.at(-1), `spotify:playlist:${ID}:play`)
  r = await rt.call('spotify_play', { link: `spotify:artist:${ID}` })
  assert.equal(opened.at(-1), `spotify:artist:${ID}`)
  assert.equal(r.spoken, 'Opened it in Spotify.')
  const n = opened.length
  for (const bad of ['https://evil.example/x', 'calc.exe', `spotify:track:${ID}:play; calc`, 'file:///C:/x']) {
    r = await rt.call('spotify_play', { link: bad })
    assert.equal(r.ok, false, bad)
  }
  assert.equal(opened.length, n, 'nothing was opened for any bad link')

  await rt.call('spotify_open_liked_songs', {})
  assert.equal(opened.at(-1), 'spotify:collection:tracks')
  assert.ok(opened.every((u) => u.startsWith('spotify:')), 'every link ever opened is a spotify: link')

  console.log('tools-spotify: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
