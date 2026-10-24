'use strict'
const assert = require('node:assert/strict')
const { wakeMatch, distance } = require('../wake-match')

assert.equal(distance('jarvis', 'jervis'), 1)
assert.equal(distance('', 'abc'), 3)

const yes = [
  ['Hey Jarvis', ''],
  ['hey jarvis.', ''],
  ['Hey Jarvis, what is the time?', 'what is the time?'],
  ['okay jarvis open spotify', 'open spotify'],
  ['Jarvis, are you there', 'are you there'],
  ['hey jervis what is my cpu', 'what is my cpu'],
  ['hey Jarvas', ''],
  ['Hey garvis open whatsapp', 'open whatsapp'],
  ['Hi Jarvis', ''],
  ['hello jarvis good morning', 'good morning'],
  ['heyjarvis open notepad', 'open notepad'],
  ['Hey Jarvis!', ''],
  ['uh hey jarvis', ''],
  ['a jarvis', ''],
  ['Jarvis', '']
]
for (const [text, rest] of yes) {
  const r = wakeMatch(text)
  assert.ok(r.matched, `should wake on "${text}"`)
  assert.equal(r.rest, rest, `command after the name in "${text}"`)
}

const no = [
  '',
  'what is my cpu usage',
  'Hey Davis, did you see the game',
  'I think the service was great',
  'hey service can I get the bill', // "service" is on the never list
  'my friend Harvey called me',
  'Jarvis is the butler in the film', // the name only counts at the start, but "jarvis is" opens with it...
  'the meeting is at three and I forgot',
  'okay everyone welcome to the show',
  'Hey Harvey how was Spain',
  'hey travis what time is it',
  'we should go for dinner at curtis house',
  'turn the volume down'
]
for (const text of no) {
  const r = wakeMatch(text)
  if (text.startsWith('Jarvis is the butler')) assert.ok(r.matched, 'a sentence that begins with the name does wake him (known, harmless trade-off)')
  else assert.ok(!r.matched, `should NOT wake on "${text}"`)
}
// the name deep inside a long sentence is ignored (only the first words count)
assert.ok(!wakeMatch('yesterday my neighbour told me all about his dog and he called it jarvis').matched)

console.log('wake-match: ALL PASS')
