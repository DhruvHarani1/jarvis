'use strict'
// Unit tests for briefing.js and the morning_briefing tool: wording, singular/plural, missing sources, failures, and privacy.
const assert = require('node:assert/strict')
const { compose, gather, senderName } = require('../briefing')
const { createBriefingTools } = require('../tools/briefing')
const { createRuntime } = require('../tools/runtime')
const { parse } = require('../fastpath')

const at = (h, m = 0) => new Date(2026, 9, 24, h, m)
const now = at(7, 41)

// ---- greeting by time of day, with and without a name
assert.match(compose({}, { now: at(7, 41) }).spoken, /^Good morning\. It is Saturday, October 24, 7:41 AM\.$/)
assert.match(compose({}, { now: at(13), name: 'Dhruv sir' }).spoken, /^Good afternoon, Dhruv sir\. /)
assert.match(compose({}, { now: at(20) }).spoken, /^Good evening\. /)
assert.match(compose({}, { now: at(2) }).spoken, /^Good evening\. /)

// ---- everything present
let b = compose({
  events: [{ title: 'Standup', start: at(10).toISOString() }, { title: 'Dentist', start: at(16).toISOString() }, { title: 'Dinner', start: at(19, 30).toISOString() }, { title: 'Gym', start: at(21).toISOString() }],
  unread: { total: 12, latest: { from: 'Mum <mum@example.com>', subject: 'Dinner on Sunday?' } },
  reminders: [{ text: 'call the bank', at: at(11).getTime() }, { text: 'water the plants', at: at(12).getTime() }, { text: 'stand up', at: at(15).getTime() }, { text: 'tomorrow thing', at: at(9).getTime() + 86_400_000 }],
  notifications: { WhatsApp: 3, Teams: 2 },
  battery: { percent: 24, charging: false }
}, { now, name: 'Dhruv sir' })
assert.equal(b.lines.length, 6)
assert.equal(b.lines[1], 'You have 4 events today: Standup at 10:00 AM, then Dentist at 4:00 PM, then Dinner at 7:30 PM, and 1 more.')
assert.equal(b.lines[2], 'You have 12 unread emails, the latest from Mum: Dinner on Sunday?.')
assert.equal(b.lines[3], 'You have 3 reminders today: call the bank at 11:00 AM, water the plants at 12:00 PM, and 1 more.')
assert.equal(b.lines[4], '5 notifications came in: 3 on WhatsApp, 2 on Teams.')
assert.equal(b.lines[5], 'Battery is at 24 percent; you may want to plug in.')
assert.ok(b.spoken.split(/\s+/).length < 110, 'short enough to listen to')

// ---- singular forms, quiet day, all-day events
b = compose({ events: [{ title: 'Holiday', start: '2026-10-24', allDay: true }], unread: { total: 1 }, reminders: [{ text: 'x', at: at(9).getTime() }] }, { now })
assert.equal(b.lines[1], 'You have one event today: Holiday all day.')
assert.equal(b.lines[2], 'You have 1 unread email.')
assert.equal(b.lines[3], 'You have 1 reminder today: x at 9:00 AM.')
b = compose({ events: [], unread: { total: 0 }, notifications: { WhatsApp: 0 }, battery: { percent: 80, charging: false } }, { now })
assert.deepEqual(b.lines.slice(1), ['Your calendar is clear for the rest of today.', 'No unread mail.'], 'nothing to say about empty notifications or a healthy battery')
b = compose({ battery: { percent: 10, charging: true } }, { now })
assert.equal(b.lines.length, 1, 'charging: no battery warning')

// ---- sources that are not connected are not mentioned; failed ones are, honestly
b = compose({ events: null, unread: null }, { now })
assert.equal(b.lines.length, 1)
b = compose({ events: [], unread: null, failed: ['mail'] }, { now })
assert.equal(b.lines.at(-1), 'I could not read your mail just now.')

// ---- long text is shortened, odd senders cope
assert.equal(senderName('"Rahul K" <r@x.example>'), 'Rahul K')
assert.equal(senderName('plain@example.com'), 'plain@example.com')
assert.equal(senderName(''), 'someone')
assert.ok(compose({ unread: { total: 2, latest: { from: 'a', subject: 'x'.repeat(300) } } }, { now }).lines[1].length < 140)

;(async () => {
  // ---- gather: isolated sources
  const store = { list: () => [{ id: 'g1', email: 'a@b.c', scopes: ['cal', 'mail'], needsSignIn: false }, { id: 'g2', email: 'old@b.c', scopes: ['cal'], needsSignIn: true }] }
  const calls = []
  const google = {
    has: () => true,
    events: async (id, r) => (calls.push(['events', id, r.from.getTime() <= r.to.getTime()]), [{ title: 'Standup', start: at(10).toISOString() }]),
    unread: async () => (calls.push(['unread']), { total: 3, messages: [{ from: 'Mum <m@x.y>', subject: 'Hi' }] })
  }
  let g = await gather({ google, store, scheduler: { list: () => [{ text: 'r', at: at(9).getTime() }] }, notifications: () => [{ app: 'WhatsApp', at: now.getTime() - 3600_000 }, { app: 'WhatsApp', at: now.getTime() - 2 * 3600_000 }, { app: 'Teams', at: now.getTime() - 20 * 3600_000 }], battery: async () => ({ percent: 50, charging: true }), now })
  assert.deepEqual(g.events.map((e) => e.title), ['Standup'])
  assert.deepEqual([g.unread.total, g.unread.latest.subject], [3, 'Hi'])
  assert.deepEqual(g.notifications, { WhatsApp: 2 }, 'only the last 12 hours')
  assert.ok(!calls.some((c) => c[1] === 'g2'), 'an account that needs signing in again is not asked')
  assert.deepEqual(g.failed, [])
  // a failing calendar does not stop the rest
  g = await gather({ google: { ...google, events: async () => Promise.reject(new Error('down')) }, store, scheduler: { list: () => { throw new Error('boom') } }, notifications: () => { throw new Error('boom') }, battery: async () => { throw new Error('no battery') }, now })
  assert.deepEqual(g.failed, ['calendar'])
  assert.equal(g.unread.total, 3)
  assert.deepEqual([g.reminders, g.notifications, g.battery], [[], {}, null])
  // nothing connected at all
  g = await gather({ now })
  assert.deepEqual([g.events, g.unread, g.failed], [null, null, []])

  // ---- the tool: tier T0, marks mail and calendar text untrusted, sends nothing anywhere
  const rt = createRuntime({ audit: { log() {} }, confirm: async () => true })
  let withData = true
  for (const t of createBriefingTools({ google, store, scheduler: { list: () => [] }, notifications: () => [], battery: async () => null, name: () => 'Dhruv sir', now: () => now })) rt.register(t)
  assert.deepEqual(rt.tiers(), [{ name: 'morning_briefing', tier: 'T0' }])
  let r = await rt.call('morning_briefing', {})
  assert.ok(r.ok && r.untrusted)
  assert.match(r.spoken, /^Good morning, Dhruv sir\. It is Saturday, October 24, 7:41 AM\. You have one event today: Standup at 10:00 AM\. You have 3 unread emails, the latest from Mum: Hi\.$/)
  const empty = createRuntime({ audit: { log() {} }, confirm: async () => true })
  for (const t of createBriefingTools({ scheduler: { list: () => [] }, notifications: () => [], name: () => '', now: () => now })) empty.register(t)
  r = await empty.call('morning_briefing', {})
  assert.equal(r.untrusted, false, 'nothing from other people in it: not untrusted')
  assert.equal(r.spoken, 'Good morning. It is Saturday, October 24, 7:41 AM.')

  // ---- voice
  for (const text of ['good morning', 'Jarvis good morning', 'morning briefing', 'brief me', 'give me my briefing', 'what does my day look like', "what's my day like", 'how is my day looking', 'catch me up', 'give me the rundown']) {
    assert.deepEqual(parse(text), { kind: 'tool', name: 'morning_briefing', args: {} }, text)
  }
  for (const text of ['good night', 'what is the weather like today', 'brief']) assert.ok(!parse(text) || parse(text).name !== 'morning_briefing', text)

  console.log('briefing: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
