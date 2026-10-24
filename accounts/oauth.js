'use strict'
/**
 * OAuth 2.0 for a desktop app: authorization code with PKCE (S256) and a loopback redirect, as Google and Microsoft recommend.
 * The sign-in happens in the user's own browser on the provider's own page; Jarvis never sees a password.
 *
 *   state    random, checked on the way back (a stray request to the loopback port cannot complete a sign-in)
 *   verifier random 64 chars, only the SHA-256 challenge leaves the PC until the code is exchanged
 *   listener 127.0.0.1 only, a random free port, closed after one answer or a timeout
 */
const crypto = require('node:crypto')
const http = require('node:http')

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const SIGNIN_TIMEOUT_MS = 3 * 60_000

const PAGE = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>Jarvis</title><body style="font:16px system-ui;background:#050b1a;color:#cfe8ff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#6fd4ff;letter-spacing:2px">${title}</h2><p>${text}</p></div></body>`

/**
 * @param {{authUrl:string, tokenUrl:string, clientId:string, clientSecret?:string, scopes:string[], extraAuthParams?:Record<string,string>}} cfg
 * @param {{openBrowser:(url:string)=>Promise<any>|void, fetch?:typeof fetch, timeoutMs?:number, now?:()=>number}} deps
 * @returns {Promise<{access_token:string, refresh_token?:string, expires_at:number, scope:string, id_token?:string}>}
 */
async function signIn(cfg, deps) {
  const doFetch = deps.fetch || fetch
  const now = deps.now || Date.now
  const state = b64url(crypto.randomBytes(24))
  const verifier = b64url(crypto.randomBytes(48))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())

  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const redirectUri = `http://127.0.0.1:${port}`

  let timer = null
  const waitForCode = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the sign-in was not finished in time')), deps.timeoutMs || SIGNIN_TIMEOUT_MS)
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri)
      if (u.pathname !== '/' || req.method !== 'GET' || (!u.searchParams.has('code') && !u.searchParams.has('error'))) {
        res.writeHead(404).end() // favicon and other strays
        return
      }
      const send = (code, title, text) => res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE(title, text))
      if (u.searchParams.get('state') !== state) {
        send(400, 'NOT ALLOWED', 'This sign-in answer did not match the one Jarvis started. Close this tab and try again in Jarvis.')
        return // keep waiting for the real answer
      }
      clearTimeout(timer)
      const err = u.searchParams.get('error')
      if (err) {
        send(200, 'NOT CONNECTED', 'You did not allow access, so nothing was connected. You can close this tab.')
        reject(new Error(err === 'access_denied' ? 'you did not allow access' : `the provider refused: ${err.slice(0, 80)}`))
      } else {
        send(200, 'CONNECTED', 'Jarvis is connected. You can close this tab.')
        resolve(u.searchParams.get('code'))
      }
    })
  })

  try {
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: cfg.scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(cfg.extraAuthParams || {})
    })
    waitForCode.catch(() => {}) // a failure is reported where it is awaited; this only prevents an unhandled rejection if the browser cannot be opened
    await deps.openBrowser(`${cfg.authUrl}?${q}`)
    const code = await waitForCode
    const body = new URLSearchParams({ client_id: cfg.clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri })
    if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret)
    return await tokenRequest(doFetch, cfg.tokenUrl, body, now)
  } finally {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections?.()
  }
}

/** @returns {Promise<{access_token:string, refresh_token?:string, expires_at:number, scope:string}>} */
async function tokenRequest(doFetch, url, body, now) {
  let res
  try {
    res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    throw new Error('could not reach the sign-in service: ' + ((e && e.message) || e))
  }
  let j = {}
  try {
    j = await res.json()
  } catch {
    /* not JSON */
  }
  if (!res.ok || !j.access_token) {
    const e = new Error(`sign-in failed: ${j.error_description || j.error || 'HTTP ' + res.status}`.slice(0, 200))
    e.code = j.error // for example invalid_grant: the user must sign in again
    throw e
  }
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: now() + Math.max(60, Number(j.expires_in) || 3600) * 1000, scope: String(j.scope || ''), id_token: j.id_token }
}

/** a new access token from a refresh token */
function refresh(cfg, refreshToken, deps = {}) {
  const body = new URLSearchParams({ client_id: cfg.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' })
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret)
  return tokenRequest(deps.fetch || fetch, cfg.tokenUrl, body, deps.now || Date.now)
}

module.exports = { signIn, refresh, b64url, SIGNIN_TIMEOUT_MS }
