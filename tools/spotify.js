'use strict'
/**
 * Spotify, for a FREE account and with no sign-in or API key.
 *
 * Why no Web API: since February 2026 Spotify only lets Premium accounts create developer apps, so playback control and search
 * through the API are not available to a free account. What the desktop app offers without any of that is its own link scheme
 * (spotify:...) and the media keys, and that is what these tools use. Playing something by NAME therefore opens Spotify's search
 * for it (you press play); playing something you can name by link or URI starts it directly. With a Premium account the Web API
 * can be added later behind the same tool names.
 *
 * Only spotify: links of a fixed shape are ever opened (never text from a model pasted into a command).
 */
const PS_TITLE = `
$p = Get-Process Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
[pscustomobject]@{ running = [bool](Get-Process Spotify -ErrorAction SilentlyContinue); title = if ($p) { $p.MainWindowTitle } else { '' } } | ConvertTo-Json -Compress`

const ID = '[A-Za-z0-9]{22}'
const KINDS = 'track|album|playlist|artist|show|episode'
const URI_RE = new RegExp(`^spotify:(${KINDS}):(${ID})$`)
const URL_RE = new RegExp(`^https://open\\.spotify\\.com/(?:intl-[a-z]{2}/)?(${KINDS})/(${ID})(?:[/?#].*)?$`)
const PLAYABLE_NOW = new Set(['track', 'album', 'playlist', 'episode']) // the desktop app starts these when ":play" is added

const obj = (properties, required = []) => ({ type: 'object', properties, required })

/** a spotify link, URI or open.spotify.com URL -> {kind, id, uri} or null */
function parseLink(input) {
  const s = String(input || '').trim()
  const m = URI_RE.exec(s) || URL_RE.exec(s)
  return m ? { kind: m[1], id: m[2], uri: `spotify:${m[1]}:${m[2]}` } : null
}

/** the window title of the Spotify desktop app -> what is playing, or null when nothing is */
function parseTitle(title) {
  const t = String(title || '').trim()
  if (!t || /^spotify( free| premium)?$/i.test(t)) return null
  const i = t.indexOf(' - ')
  return i > 0 ? { artist: t.slice(0, i).trim(), title: t.slice(i + 3).trim() } : { artist: '', title: t }
}

const cleanQuery = (q) => String(q || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)

/** @param {{ps:(script:string,arg?:any)=>Promise<string>, shell:{openExternal:(u:string)=>Promise<any>}, sleep?:(ms:number)=>Promise<void>}} d */
function createSpotifyTools(d) {
  const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const state = async () => JSON.parse(await d.ps(PS_TITLE))
  const T = []

  T.push({
    name: 'spotify_now_playing',
    tier: 'T0',
    description: 'Say what Spotify is playing right now (song and artist), read from the Spotify app.',
    schema: obj({}),
    run: async () => {
      const s = await state()
      if (!s.running) return { spoken: 'Spotify is not open.', data: { running: false } }
      const np = parseTitle(s.title)
      if (!np) return { spoken: 'Nothing is playing in Spotify right now.', data: { running: true, playing: false } }
      return { spoken: np.artist ? `${np.title} by ${np.artist}.` : `${np.title}.`, data: { running: true, playing: true, ...np }, untrusted: true }
    }
  })

  T.push({
    name: 'spotify_search',
    tier: 'T1',
    description: 'Open Spotify on its search results for a song, artist, album or playlist name. The user then presses play. Use this when the user asks to play something by name.',
    schema: obj({ query: { type: 'string', minLength: 1, maxLength: 100 } }, ['query']),
    run: async ({ query }) => {
      const q = cleanQuery(query)
      if (!q) throw new Error('what should I search for?')
      await d.shell.openExternal(`spotify:search:${encodeURIComponent(q)}`)
      return { spoken: `I opened Spotify's search for ${q}. Press play on the one you want.`, data: { query: q } }
    }
  })

  T.push({
    name: 'spotify_play',
    tier: 'T1',
    description: 'Start a specific Spotify track, album, playlist or episode from its spotify: URI or open.spotify.com link. Artists and shows are opened, not started.',
    schema: obj({ link: { type: 'string', minLength: 10, maxLength: 200 } }, ['link']),
    run: async ({ link }) => {
      const p = parseLink(link)
      if (!p) throw new Error('that is not a Spotify link I can use')
      const uri = PLAYABLE_NOW.has(p.kind) ? `${p.uri}:play` : p.uri
      await d.shell.openExternal(uri)
      return { spoken: PLAYABLE_NOW.has(p.kind) ? 'Playing it in Spotify.' : 'Opened it in Spotify.', data: { kind: p.kind } }
    }
  })

  T.push({
    name: 'spotify_open_liked_songs',
    tier: 'T1',
    description: 'Open the Liked Songs page in Spotify.',
    schema: obj({}),
    run: async () => {
      await d.shell.openExternal('spotify:collection:tracks')
      return { spoken: 'Opening your Liked Songs.' }
    }
  })

  return T
}

module.exports = { createSpotifyTools, parseLink, parseTitle, cleanQuery, PS_TITLE }
