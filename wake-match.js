'use strict'
/**
 * Finds "Jarvis" at the start of what a speech model wrote down, forgivingly: speech models spell an unusual name many ways
 * (jervis, jarvas, garvis, "hey service"). Returns whether it matched and what was said after it (the command, if there is one).
 * Pure functions, unit-tested.
 */
const NAME = 'jarvis'
const GREETINGS = new Set(['hey', 'hay', 'hi', 'hello', 'okay', 'ok', 'o.k', 'yo', 'a', 'hei', 'he', 'hate', 'hey,'])
// real words that sound close but are almost never meant as the wake word, even after a greeting
const NOT_NAMES = new Set(['harvey', 'harvest', 'davis', 'curtis', 'marvin', 'jarvik', 'service', 'services', 'servers', 'jarrett', 'jervais', 'javier', 'carvis'])
// close enough to the name on their own, no greeting needed
const SPELLINGS = new Set(['jarvis', 'jervis', 'jarvas', 'jarvus', 'garvis', 'charvis', 'jarvice', 'jarvise', 'jarviss', 'jarviz', 'jarves', 'jarvist', 'javis', 'jarvi', 'jarvic', 'jarvish', 'gervis', 'gervais', 'zharvis', 'darvis', 'jarbis', 'jarvas', 'jarvus', 'yarvis'])

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

const clean = (w) => String(w).toLowerCase().replace(/[^a-z]/g, '')

/**
 * @param {string} text what was heard
 * @returns {{matched:boolean, rest:string, word:string}} rest = the words after the name, as written
 */
function wakeMatch(text) {
  const raw = String(text || '').trim()
  if (!raw) return { matched: false, rest: '', word: '' }
  const words = raw.split(/\s+/)
  // "hey jarvis" run together by the recogniser
  const first = clean(words[0])
  if (/^(hey|hay|hi|okay|ok)jarvis/.test(first) && first.length <= 12) return { matched: true, rest: words.slice(1).join(' ').replace(/^[,.\s]+/, ''), word: words[0] }
  for (let i = 0; i < Math.min(words.length, 4); i++) {
    const w = clean(words[i])
    if (!w || w.length < 4 || w.length > 9) continue
    if (NOT_NAMES.has(w)) continue
    const greeted = i > 0 && GREETINGS.has(clean(words[i - 1]))
    const d = distance(w, NAME)
    const ok = w === NAME || SPELLINGS.has(w) || (d <= 1 && w.length >= 5) || (d <= 2 && greeted && w.length >= 5) || (i === 0 && d <= 2 && w.length >= 6 && w[0] === 'j')
    if (ok) return { matched: true, rest: words.slice(i + 1).join(' ').replace(/^[,.\s]+/, ''), word: words[i] }
  }
  return { matched: false, rest: '', word: '' }
}

module.exports = { wakeMatch, distance }
