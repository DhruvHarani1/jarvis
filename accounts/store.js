'use strict'
/**
 * Connected accounts (Google now, Microsoft next). The refresh token and the client secret are encrypted with Windows DPAPI
 * (Electron safeStorage) before they touch the disk; if encryption is not available nothing is saved. The window only ever
 * sees the public view: provider, address, granted permissions.
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** @param {{file:string, crypt:{available:()=>boolean, enc:(s:string)=>string, dec:(s:string)=>string}, now?:()=>number}} deps */
function create({ file, crypt, now = Date.now }) {
  let data = { accounts: [] }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j && Array.isArray(j.accounts)) data = { accounts: j.accounts.filter((a) => a && typeof a.id === 'string' && typeof a.provider === 'string') }
  } catch {
    /* first run, or unreadable: start empty */
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  const pub = (a) => ({ id: a.id, provider: a.provider, email: a.email, scopes: a.scopes, clientIdHint: a.clientId ? '…' + String(a.clientId).slice(0, 8) : '', addedAt: a.addedAt, needsSignIn: !!a.needsSignIn })

  return {
    list: (provider) => data.accounts.filter((a) => !provider || a.provider === provider).map(pub),
    /** everything including decrypted secrets: main process only */
    get(id) {
      const a = data.accounts.find((x) => x.id === id)
      if (!a) return null
      return { ...pub(a), clientId: a.clientId, clientSecret: a.secretEnc ? crypt.dec(a.secretEnc) : '', refreshToken: a.refreshEnc ? crypt.dec(a.refreshEnc) : '' }
    },
    add({ provider, email, clientId, clientSecret, refreshToken, scopes }) {
      if (!crypt.available()) throw new Error('Windows encryption is not available, so I will not store a sign-in')
      if (!refreshToken) throw new Error('the provider did not give a long-lived sign-in; try again and allow offline access')
      const existing = data.accounts.find((a) => a.provider === provider && String(a.email).toLowerCase() === String(email).toLowerCase())
      const rec = {
        id: existing ? existing.id : crypto.randomBytes(6).toString('hex'),
        provider,
        email,
        clientId,
        secretEnc: clientSecret ? crypt.enc(clientSecret) : '',
        refreshEnc: crypt.enc(refreshToken),
        scopes: [...scopes],
        addedAt: existing ? existing.addedAt : now(),
        needsSignIn: false
      }
      data.accounts = existing ? data.accounts.map((a) => (a.id === rec.id ? rec : a)) : [...data.accounts, rec]
      save()
      return pub(rec)
    },
    setNeedsSignIn(id, v) {
      const a = data.accounts.find((x) => x.id === id)
      if (a && a.needsSignIn !== !!v) {
        a.needsSignIn = !!v
        save()
      }
    },
    remove(id) {
      const n = data.accounts.length
      data.accounts = data.accounts.filter((a) => a.id !== id)
      if (data.accounts.length !== n) save()
      return data.accounts.length !== n
    }
  }
}

module.exports = { create }
