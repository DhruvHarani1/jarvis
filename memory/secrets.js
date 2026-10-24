'use strict'
/**
 * Memory must never hold secrets. Anything that looks like a key, token, password or card number is refused before it is stored,
 * so it can never be fed back into a prompt and sent to an AI provider.
 */
const PATTERNS = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, 'an API key'],
  [/\bgsk_[A-Za-z0-9]{16,}/, 'an API key'],
  [/\bnvapi-[A-Za-z0-9_-]{16,}/, 'an API key'],
  [/\bAIza[0-9A-Za-z_-]{20,}/, 'an API key'],
  [/\bGOCSPX-[0-9A-Za-z_-]{10,}/, 'a client secret'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'a cloud key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'a login token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:pass(?:word|code|wd)?|pin|otp|secret|api[ _-]?key|token)\b\s*(?:is|=|:|are)\s*\S{4,}/i, 'a password or secret'],
  [/\b[A-Fa-f0-9]{40,}\b/, 'a long secret-looking value'],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}(?![A-Za-z0-9])/, 'a long secret-looking value']
]

function luhn(digits) {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** @returns {string|null} what it looks like, or null when it is fine to remember */
function looksSecret(text) {
  const t = String(text || '')
  for (const [re, what] of PATTERNS) if (re.test(t)) return what
  for (const m of t.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const d = m[0].replace(/[ -]/g, '')
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'a card number'
  }
  return null
}

module.exports = { looksSecret, luhn }
