'use strict'
// Unit tests for accounts/oauth.js against a fake provider: PKCE, state check, denial, timeout, refresh, error handling.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const oauth = require('../accounts/oauth')

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

;(async () => {
  // a fake provider: /auth (the "browser" page) and /token
  const seen = { auth: null, token: [] }
  let tokenResponse = (body) => ({ status: 200, json: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3599, scope: body.get('scope') || 'a b' } })
  const provider = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/auth') {
      seen.auth = Object.fromEntries(u.searchParams)
      res.writeHead(200).end('ok')
      return
    }
    if (u.pathname === '/token') {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        const body = new URLSearchParams(data)
        seen.token.push(Object.fromEntries(body))
        const r = tokenResponse(body)
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json))
      })
    }
  })
  await new Promise((r) => provider.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${provider.address().port}`
  const cfg = { authUrl: base + '/auth', tokenUrl: base + '/token', clientId: 'CID', clientSecret: 'SEC', scopes: ['openid', 'email', 'https://x/gmail.readonly'], extraAuthParams: { access_type: 'offline', prompt: 'consent' } }

  /** the "browser": reads the auth URL, then calls the redirect like the provider would */
  const browser = (mutate = (q) => q) => async (url) => {
    await fetch(url) // reaches /auth on the fake provider, which records the parameters
    const q = mutate({ code: 'CODE123', state: seen.auth.state })
    const back = new URL(seen.auth.redirect_uri)
    for (const [k, v] of Object.entries(q)) if (v !== undefined) back.searchParams.set(k, v)
    setImmediate(() => void fetch(back))
  }

  // happy path
  const t = await oauth.signIn(cfg, { openBrowser: browser(), now: () => 1_000_000 })
  assert.deepEqual([t.access_token, t.refresh_token, t.expires_at], ['AT1', 'RT1', 1_000_000 + 3599_000])
  assert.equal(seen.auth.client_id, 'CID')
  assert.equal(seen.auth.response_type, 'code')
  assert.equal(seen.auth.code_challenge_method, 'S256')
  assert.equal(seen.auth.access_type, 'offline')
  assert.equal(seen.auth.scope, 'openid email https://x/gmail.readonly')
  assert.match(seen.auth.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback only')
  const tok = seen.token[0]
  assert.equal(tok.code, 'CODE123')
  assert.equal(tok.grant_type, 'authorization_code')
  assert.equal(tok.client_secret, 'SEC')
  assert.equal(tok.redirect_uri, seen.auth.redirect_uri)
  assert.equal(b64url(crypto.createHash('sha256').update(tok.code_verifier).digest()), seen.auth.code_challenge, 'the verifier matches the challenge sent earlier (PKCE)')
  assert.ok(tok.code_verifier.length >= 43 && tok.code_verifier.length <= 128)
  assert.ok(seen.auth.state.length >= 24)

  // the verifier and state are different on every sign-in
  await oauth.signIn(cfg, { openBrowser: browser() })
  assert.notEqual(seen.token[1].code_verifier, tok.code_verifier)

  // no secret configured: none is sent
  await oauth.signIn({ ...cfg, clientSecret: undefined }, { openBrowser: browser() })
  assert.equal(seen.token.at(-1).client_secret, undefined)

  // a wrong state is refused and the real answer still works afterwards
  {
    let phase = 0
    const t2 = await oauth.signIn(cfg, {
      openBrowser: async (url) => {
        await fetch(url)
        const back = new URL(seen.auth.redirect_uri)
        back.searchParams.set('code', 'EVIL')
        back.searchParams.set('state', 'wrong')
        const bad = await fetch(back)
        assert.equal(bad.status, 400, 'a wrong state gets an error page')
        phase = 1
        const good = new URL(seen.auth.redirect_uri)
        good.searchParams.set('code', 'GOODCODE')
        good.searchParams.set('state', seen.auth.state)
        setImmediate(() => void fetch(good))
      }
    })
    assert.equal(phase, 1)
    assert.equal(seen.token.at(-1).code, 'GOODCODE', 'the forged code was never exchanged')
    assert.equal(t2.access_token, 'AT1')
  }

  // strays (favicon, wrong method) do not end the wait
  {
    await oauth.signIn(cfg, {
      openBrowser: async (url) => {
        await fetch(url)
        const stray = new URL(seen.auth.redirect_uri + '/favicon.ico')
        assert.equal((await fetch(stray)).status, 404)
        const back = new URL(seen.auth.redirect_uri)
        back.searchParams.set('code', 'C')
        back.searchParams.set('state', seen.auth.state)
        setImmediate(() => void fetch(back))
      }
    })
  }

  // the user says no
  await assert.rejects(oauth.signIn(cfg, { openBrowser: browser((q) => ({ error: 'access_denied', state: q.state })) }), /you did not allow access/)

  // never finished: times out and closes its port
  {
    let port = 0
    await assert.rejects(oauth.signIn(cfg, { timeoutMs: 150, openBrowser: async (url) => (await fetch(url), (port = new URL(seen.auth.redirect_uri).port)) }), /not finished in time/)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), undefined, 'the loopback port is closed afterwards')
  }

  // browser cannot be opened: clear error, no dangling timer or unhandled rejection
  await assert.rejects(oauth.signIn({ ...cfg }, { timeoutMs: 100, openBrowser: async () => Promise.reject(new Error('no browser')) }), /no browser/)
  await new Promise((r) => setTimeout(r, 250))

  // token endpoint errors
  tokenResponse = () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Bad Request' } })
  const err = await oauth.signIn(cfg, { openBrowser: browser() }).catch((e) => e)
  assert.match(err.message, /sign-in failed: Bad Request/)
  assert.equal(err.code, 'invalid_grant')
  tokenResponse = () => ({ status: 200, json: { not: 'a token' } })
  await assert.rejects(oauth.signIn(cfg, { openBrowser: browser() }), /sign-in failed/)

  // refresh
  tokenResponse = (body) => ({ status: 200, json: { access_token: 'AT2', expires_in: 3600, scope: 'a' } })
  const r2 = await oauth.refresh(cfg, 'RT1', { now: () => 5_000 })
  assert.deepEqual([r2.access_token, r2.refresh_token, r2.expires_at], ['AT2', undefined, 5_000 + 3_600_000])
  const rb = seen.token.at(-1)
  assert.deepEqual([rb.grant_type, rb.refresh_token, rb.client_id, rb.client_secret], ['refresh_token', 'RT1', 'CID', 'SEC'])
  tokenResponse = () => ({ status: 400, json: { error: 'invalid_grant' } })
  const e3 = await oauth.refresh(cfg, 'RT1').catch((e) => e)
  assert.equal(e3.code, 'invalid_grant')

  provider.close()
  console.log('oauth: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
