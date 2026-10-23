'use strict'
// Unit tests for fastpath.js: what is understood locally, what is passed on to the language model.
const assert = require('node:assert/strict')
const { parse, num } = require('../fastpath')

const tool = (name, args) => ({ kind: 'tool', name, args })

// numbers
for (const [s, n] of [['5', 5], ['twenty five', 25], ['twenty-five', 25], ['a', 1], ['an', 1], ['half an', 0.5], ['ninety', 90], ['seventeen', 17], ['2.5', 2.5]]) assert.equal(num(s), n, s)
for (const s of ['', 'banana', 'twenty twenty', 'thirty zero']) assert.equal(num(s), null, s)

const cases = [
  // timers
  ['set a timer for 5 minutes', tool('set_timer', { minutes: 5 })],
  ['Jarvis, set a timer for ten minutes please', tool('set_timer', { minutes: 10 })],
  ['timer 30 seconds', tool('set_timer', { minutes: 0.5 })],
  ['start a 25 minute timer', tool('set_timer', { minutes: 25 })],
  ['set a timer for an hour', tool('set_timer', { minutes: 60 })],
  ['set a timer for half an hour', tool('set_timer', { minutes: 30 })],
  ['set a timer for two hours', tool('set_timer', { minutes: 120 })],
  // reminders
  ['remind me in 20 minutes to stretch', tool('add_reminder', { text: 'stretch', in_minutes: 20 })],
  ['remind me in an hour to call mum', tool('add_reminder', { text: 'call mum', in_minutes: 60 })],
  ['remind me to drink water in ten minutes', tool('add_reminder', { text: 'drink water', in_minutes: 10 })],
  // volume, mute, media
  ['volume 30', tool('set_volume', { level: 30 })],
  ['set the volume to fifty', tool('set_volume', { level: 50 })],
  ['set volume to 80 percent', tool('set_volume', { level: 80 })],
  ['turn the volume up', tool('media_key', { action: 'volume_up', times: 5 })],
  ['quieter', tool('media_key', { action: 'volume_down', times: 5 })],
  ['mute', tool('mute', { muted: true })],
  ['unmute', tool('mute', { muted: false })],
  ['pause', tool('media_key', { action: 'play_pause' })],
  ['pause the music', tool('media_key', { action: 'play_pause' })],
  ['resume', tool('media_key', { action: 'play_pause' })],
  ['next song', tool('media_key', { action: 'next' })],
  ['skip', tool('media_key', { action: 'next' })],
  ['previous track', tool('media_key', { action: 'previous' })],
  // apps and web
  ['open Spotify', tool('open_app', { name: 'spotify' })],
  ['could you launch the calculator app', tool('open_app', { name: 'calculator' })],
  ['open microsoft teams', tool('open_app', { name: 'microsoft teams' })],
  ['open youtube', tool('open_url', { url: 'https://www.youtube.com/' })],
  ['open gmail', tool('open_url', { url: 'https://mail.google.com/' })],
  // status, undo
  ['how is my pc doing', tool('system_status', {})],
  ['what is my battery level', null],
  ['battery', tool('system_status', {})],
  ['what are my reminders', tool('list_reminders', {})],
  ['undo that', { kind: 'undo' }],
  ['undo', { kind: 'undo' }]
]
for (const [text, want] of cases) assert.deepEqual(parse(text), want, JSON.stringify(text))

// time and date are answered with the given clock
const d = new Date(2026, 9, 24, 15, 30)
assert.deepEqual(parse('what time is it', { now: d }), { kind: 'say', text: 'It is 3:30 PM.' })
assert.deepEqual(parse("what's the date today", { now: d }), { kind: 'say', text: 'It is Saturday, October 24.' })

// must NOT be handled here (left for the language model or other commands)
for (const text of [
  '', '   ', 'tell me a joke', 'why is the sky blue', 'what is the weather like today',
  'open the pod bay doors and tell me a story about a very long adventure that never ends ok', // too long
  'open timer', 'start focus', 'open notifications',
  'set a timer for banana minutes', 'set a timer for 0 minutes', 'set a timer for 5000 minutes', 'volume 150', 'volume 3.5', 'set the volume to loud',
  'remind me', 'remind me in 20 minutes', 'delete the file called taxes', 'send a message to mum saying hello', 'play despacito on spotify'
]) assert.equal(parse(text), null, JSON.stringify(text))

console.log('fastpath: ALL PASS')
