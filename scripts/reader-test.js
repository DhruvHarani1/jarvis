'use strict'
// Unit tests for the Notification Reader's pure part: sentences, cleaning, filtering, digests.
const assert = require('node:assert/strict')
const R = require('../renderer/reader.js')

const NAME = 'Dhruv sir'
const say = (item, o = {}) => R.phrase(item, { name: NAME, ...o })

// ---- the example from the request, word for word
{
  const p = say({ app: 'WhatsApp', title: 'Mum', body: 'dhruv dont worry' })
  assert.equal(p.text, 'Dhruv sir, you received a message from Mum on WhatsApp. The message is: dhruv dont worry')
  assert.equal(p.kind, 'message')
  assert.equal(p.urgent, false)
}

// ---- without a name set there is simply no address
assert.equal(R.phrase({ app: 'WhatsApp', title: 'Mum', body: 'hi' }).text, 'you received a message from Mum on WhatsApp. The message is: hi')

// ---- group chats: "Sender: text" under the group's title
{
  const p = say({ app: 'WhatsApp', title: 'Family', body: 'Papa: dinner at 8' })
  assert.equal(p.text, 'Dhruv sir, you received a message from Papa in Family on WhatsApp. The message is: dinner at 8')
  assert.equal(p.who, 'Papa')
}

// ---- WhatsApp's "(3 messages)" counter is dropped
assert.match(say({ app: 'WhatsApp', title: 'Rahul (3 messages)', body: 'ping' }).text, /from Rahul on WhatsApp/)

// ---- media messages are described, not spelled out
assert.match(say({ app: 'WhatsApp', title: 'Mum', body: '📷 Photo' }).text, /They sent a photo\.$/)
assert.match(say({ app: 'WhatsApp', title: 'Mum', body: '🎤 0:23' }).text, /They sent a voice message\./)
assert.match(say({ app: 'Telegram', title: 'Raj', body: '🎥 Video' }).text, /They sent a video\./)
assert.match(say({ app: 'WhatsApp', title: 'Mum', body: '📄 report.pdf' }).text, /message is: report\.pdf|They sent/)

// ---- other chat apps use the same wording
assert.match(say({ app: 'Telegram', title: 'Raj', body: 'ready?' }).text, /from Raj on Telegram\. The message is: ready\?/)
assert.match(say({ app: 'Teams', title: 'Ashwini', body: 'suggestion 1' }).text, /from Ashwini on Teams/)
assert.match(say({ app: 'Discord', title: 'Sam', body: 'gg' }).text, /on Discord/)

// ---- email
{
  const p = say({ app: 'Mail', title: 'Amazon', body: 'Your order has shipped' })
  assert.equal(p.text, 'Dhruv sir, you have a new email from Amazon on Mail. The subject is: Your order has shipped')
  assert.equal(p.kind, 'email')
}

// ---- calls are urgent and ring out loud
{
  const p = say({ app: 'WhatsApp', title: 'Mum', body: 'Incoming voice call' })
  assert.equal(p.kind, 'call')
  assert.equal(p.urgent, true)
  assert.equal(p.text, 'Dhruv sir, Mum is calling you on WhatsApp.')
  assert.equal(say({ app: 'WhatsApp', title: 'Mum', body: 'Missed voice call' }).urgent, false, 'a missed call is not urgent')
}

// ---- calendar, system, generic web push
assert.match(say({ app: 'Calendar', title: 'Standup', body: 'in 5 minutes' }).text, /^Dhruv sir, calendar reminder: Standup\. in 5 minutes/)
assert.match(say({ app: 'Windows Security', title: 'Scan finished', body: 'No threats' }).text, /Windows says: Scan finished\. No threats/)
{
  const p = say({ app: 'youtube.com', title: 'Soma Chhaya', body: 'watch this' })
  assert.equal(p.app, 'YouTube')
  assert.match(p.text, /new notification from YouTube\. Soma Chhaya\. watch this/)
}

// ---- private mode: who, never what
assert.equal(say({ app: 'WhatsApp', title: 'Mum', body: 'secret thing' }, { mode: 'private' }).text, 'Dhruv sir, you received a message from Mum on WhatsApp.')
assert.ok(!/subject/i.test(say({ app: 'Mail', title: 'Bank', body: 'Your balance' }, { mode: 'private' }).text))
assert.ok(!/balance/.test(say({ app: 'Mail', title: 'Bank', body: 'Your balance' }, { mode: 'private' }).text))
assert.ok(!/watch/.test(say({ app: 'youtube.com', title: 'X', body: 'watch this' }, { mode: 'private' }).text))

// ---- text cleaning for a speech engine
assert.equal(R.toSpeech('see https://example.com/x?y=1 now'), 'see a link now')
assert.equal(R.toSpeech('heeeeeeey!!!!! 😀😀'), 'heeey!')
assert.equal(R.toSpeech('**bold** _it_ ~x~'), 'bold it x')
assert.equal(R.stripEmoji('hi 👍🏽 there 🇮🇳'), 'hi there')
assert.ok(R.truncate('word '.repeat(200)).endsWith('… and more.'))
assert.equal(R.truncate('short'), 'short')
{
  const long = say({ app: 'WhatsApp', title: 'Mum', body: 'blah '.repeat(200) })
  assert.ok(long.text.length < 340, 'long messages are cut so she does not talk for a minute')
}

// ---- messages that are not in a script an English voice can read
assert.match(say({ app: 'WhatsApp', title: 'Mum', body: 'क्या हाल है आज कैसे हो' }).text, /not in English, so I left it on screen/)
assert.ok(R.nonLatinShare('hello') === 0 && R.nonLatinShare('नमस्ते') > 0.9)
assert.match(say({ app: 'youtube.com', title: 'तुला राशि नवंबर', body: 'राशिफल' }).text, /not in English/)

// ---- who gets read: muted apps, stale items, repeats
{
  const now = 1_000_000
  const seen = new Map()
  const cfg = { muted: ['lyra', 'settings'] }
  const mk = (app, title, body = '', age = 0) => ({ app, title, body, at: now - age })
  let r = R.select([mk('WhatsApp', 'Mum', 'hi'), mk('Lyra', 'Paper Lanterns', 'Ora Vale'), mk('Settings', 'Restart required')], cfg, now, seen)
  assert.deepEqual(r.map((i) => i.app), ['WhatsApp'], 'muted apps are skipped')
  r = R.select([mk('WhatsApp', 'Mum', 'hi')], cfg, now + 5_000, seen)
  assert.equal(r.length, 0, 'the same message twice within a minute is read once')
  r = R.select([mk('WhatsApp', 'Mum', 'hi')], cfg, now + 120_000, seen)
  assert.equal(r.length, 1, 'but a minute later it is new again')
  r = R.select([mk('Mail', 'Old', 'x', 10 * 60_000)], cfg, now, new Map())
  assert.equal(r.length, 0, 'notifications older than 3 minutes (startup backfill) are not read')
  assert.equal(R.isMuted({ app: 'youtube.com' }, ['youtube']), true, 'muting "youtube" covers youtube.com')
  assert.equal(R.isMuted({ app: 'WhatsApp' }, ['mail']), false)
  assert.equal(R.isMuted({ app: 'Anything' }, []), false)
}

// ---- digests
{
  const items = [
    { app: 'WhatsApp', title: 'Mum', body: 'a' },
    { app: 'WhatsApp', title: 'Dad', body: 'b' },
    { app: 'WhatsApp', title: 'Raj', body: 'c' },
    { app: 'Mail', title: 'Amazon', body: 'shipped' }
  ]
  const d = R.digest(items, { name: NAME, reason: 'away' })
  assert.match(d, /^Welcome back, Dhruv sir\. While you were away, you received 4 notifications: 3 from WhatsApp, 1 from Mail\./)
  assert.match(d, /The latest is from Amazon on Mail\./)
  assert.match(d, /Say "what did I miss" to hear them\.$/)
  assert.match(R.digest(items, { name: NAME, reason: 'focus' }), /^Focus session over, Dhruv sir\. While you were focused/)
  assert.match(R.digest(items, { name: NAME, reason: 'burst' }), /^Dhruv sir, you received 4 notifications/)
  assert.ok(!/latest is from/.test(R.digest(items, { name: NAME, mode: 'private' })), 'private digests do not name senders')
  assert.equal(R.digest([], {}), '')
  assert.match(R.digest([items[0]], {}), /1 notification: 1 from WhatsApp/)
}

// ---- the short form for "what did I miss"
assert.equal(R.brief({ app: 'WhatsApp', title: 'Mum', body: 'dinner' }), 'Mum on WhatsApp: dinner')
assert.equal(R.brief({ app: 'WhatsApp', title: 'Mum', body: 'dinner' }, { mode: 'private' }), 'Mum on WhatsApp.')

// ---- nothing weird gets through
assert.doesNotThrow(() => R.phrase({ app: undefined, title: undefined, body: undefined }))
assert.doesNotThrow(() => R.phrase({ app: 'WhatsApp', title: '', body: '' }))
assert.equal(R.phrase({ app: 'WhatsApp', title: '', body: '' }).who, 'someone')

console.log('reader: ALL PASS')
