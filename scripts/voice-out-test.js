'use strict'
// Unit tests for voice-out.js: neural voice path, Windows fallback, queueing, stop and urgent.
const assert = require('node:assert/strict')
const voiceOut = require('../voice-out')

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

function rig({ ready = true, synth } = {}) {
  const sent = []
  const sapi = []
  const events = []
  const speech = {
    clean: (t) => String(t).trim(),
    speak: async (t, o) => sapi.push([t, o && o.queue]),
    stop: () => sapi.push('stop'),
    warm: () => sapi.push('warm'),
    setOnStart: () => {},
    setOnIdle: () => {},
    setOnBusy: () => {},
    setVoice: () => {},
    getVoice: () => '',
    listVoices: async () => [],
    resolveVoice: () => null
  }
  const audio = {
    speak: synth || (async (t) => ({ samples: new Float32Array(100).fill(t.length), rate: 22050 })),
    status: async () => ({})
  }
  const v = voiceOut.create({ speech, audio, send: (c, p) => sent.push([c, p]), ready: () => ready })
  v.setOnStart((tag) => events.push(['start', tag]))
  v.setOnIdle(() => events.push(['idle']))
  v.setOnBusy((b) => events.push(['busy', b]))
  return { v, sent, sapi, events }
}
const plays = (sent) => sent.filter(([c]) => c === 'tts:play').map(([, p]) => p)

;(async () => {
  assert.equal(voiceOut.tidy('**Hello** [there](http://x.y) `code` \n\n see https://a.b/c now'), 'Hello there code see now')
  assert.equal(voiceOut.tidy('Good morning, Sir.'), 'Good morning, Sir.', 'case is kept')

  // no voice model: everything goes to the Windows voice
  {
    const { v, sent, sapi } = rig({ ready: false })
    await v.speak('Hello there', { queue: true })
    assert.deepEqual(sapi, [['Hello there', true]])
    assert.equal(plays(sent).length, 0)
    assert.equal(v.neural, false)
  }

  // neural: sentences are synthesised and sent to the window one after the other; events follow what the window reports
  {
    const { v, sent, events } = rig()
    assert.equal(v.neural, true)
    await v.speak('First sentence.', { queue: true, tag: 'a' })
    await v.speak('Second one.', { queue: true, tag: 'b' })
    await tick(60)
    let p = plays(sent)
    assert.ok(p.length >= 1 && p[0].rate === 22050)
    assert.equal(p[0].samples[0], 'First sentence.'.length, 'text is sent as written (case kept)')
    assert.deepEqual(events.filter((e) => e[0] === 'busy'), [['busy', true]])
    v.played({ id: p[0].id, state: 'started' })
    assert.deepEqual(events.find((e) => e[0] === 'start'), ['start', 'a'])
    v.played({ id: 999, state: 'started' }) // unknown / untagged: no announcement
    assert.equal(events.filter((e) => e[0] === 'start').length, 1)
    v.played({ id: p[0].id, state: 'ended' })
    await tick(60)
    p = plays(sent)
    assert.equal(p.length, 2, 'second sentence follows')
    assert.equal(events.some((e) => e[0] === 'idle'), false, 'not idle while a sentence is still to come')
    v.played({ id: p[1].id, state: 'started' })
    v.played({ id: p[1].id, state: 'ended' })
    assert.deepEqual(events.slice(-2), [['busy', false], ['idle']])
  }

  // speaking without queue interrupts: the window is told to stop and the old queue is dropped
  {
    const { v, sent } = rig()
    await v.speak('Long one one one.', { queue: true })
    await v.speak('Replacement.')
    await tick(60)
    assert.ok(sent.some(([c]) => c === 'tts:stop'))
    const last = plays(sent).at(-1)
    assert.equal(last.samples[0], 'Replacement.'.length)
  }

  // stop() while a sentence is still being synthesised: that audio is thrown away
  {
    let release
    const gate = new Promise((r) => (release = r))
    const { v, sent } = rig({ synth: async () => (await gate, { samples: new Float32Array(10).fill(1), rate: 22050 }) })
    await v.speak('Slow sentence.', { queue: true })
    await tick(5)
    v.stop()
    release()
    await tick(30)
    assert.equal(plays(sent).length, 0, 'nothing is played after stop()')
  }

  // synthesis failure: that sentence falls back to Windows and the neural voice rests for a while
  {
    const { v, sapi } = rig({ synth: async () => Promise.reject(new Error('worker died')) })
    await v.speak('Fallback please.', { queue: true })
    await tick(30)
    assert.deepEqual(sapi, [['Fallback please.', true]])
    assert.equal(v.neural, false, 'neural voice is paused after a failure')
    await v.speak('Next one.', { queue: true })
    assert.deepEqual(sapi.at(-1), ['Next one.', true])
  }

  // urgent jumps the queue and cuts what is playing
  {
    const { v, sent } = rig()
    await v.speak('Normal talk.', { queue: true })
    await v.speak('Call incoming.', { queue: true, urgent: true })
    await tick(60)
    assert.ok(sent.filter(([c]) => c === 'tts:stop').length >= 1)
    assert.ok(plays(sent).some((p) => p.samples[0] === 'Call incoming.'.length))
  }

  // empty / junk text makes no sound
  {
    const { v, sent } = rig()
    await v.speak('   ', { queue: true })
    await tick(20)
    assert.equal(plays(sent).length, 0)
  }

  console.log('voice-out: ALL PASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
