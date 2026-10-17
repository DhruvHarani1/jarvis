'use strict'
// Silent unit tests for Karen's voice plumbing: a fake "speaker" process speaks the same line protocol as the real one.
// SPEECH_LIVE=1 also speaks real sentences through your speakers.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const speech = require('../speech')
const { clean, SCRIPT, MAX_CHARS, MAX_QUEUE } = speech

assert.equal(clean('  HELLO,   I’M  KAREN.\n\nTHWIP!  '), 'hello, i’m karen. thwip!')
assert.equal(clean('a\u0000b\u001bc\u007fd'), 'a b c d', 'control characters never reach the speech engine')
assert.equal(clean(''), '')
assert.equal(clean(null), '')
assert.equal(clean('x'.repeat(5000)).length, MAX_CHARS)

// the engine script reads base64 lines from stdin, speaks asynchronously (so it can be cancelled) and never embeds user text
assert.match(SCRIPT, /OpenStandardInput/)
assert.match(SCRIPT, /FromBase64String/)
assert.match(SCRIPT, /SpeakAsync\(\$t\)/)
assert.match(SCRIPT, /SpeakAsyncCancelAll/)
assert.ok(!/\$\{|`/.test(SCRIPT), 'script has no interpolation hooks')

/** fake powershell speaker implementing READY / V / C / S -> DONE */
function fakeEngine(ms = 20) {
  const log = { spoken: [], spawns: 0, killed: 0, cancels: 0, voices: [], env: [] }
  const fn = (_cmd, _args, opts) => {
    log.spawns++
    log.env.push(opts?.env?.SPIDEY_VOICE)
    const child = new EventEmitter()
    child.exitCode = null
    child.stdout = new EventEmitter()
    let timer = null
    const done = () => {
      timer = null
      child.stdout.emit('data', 'DONE\n')
    }
    child.stdin = {
      on() {},
      write(chunk) {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          if (line.startsWith('V ')) log.voices.push(line.slice(2))
          else if (line === 'C') {
            log.cancels++
            if (timer) {
              clearTimeout(timer)
              done()
            }
          } else if (line.startsWith('S ')) {
            log.spoken.push(Buffer.from(line.slice(2), 'base64').toString('utf8'))
            timer = setTimeout(done, ms)
          }
        }
      }
    }
    child.kill = () => {
      if (child.exitCode === null) {
        log.killed++
        child.exitCode = 1
        clearTimeout(timer)
        child.emit('close', 1)
      }
    }
    setTimeout(() => child.stdout.emit('data', 'READY\n'), 5)
    return child
  }
  return { fn, log }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  assert.deepEqual(await speech.speak(''), { ok: true, ms: 0 }, 'empty text is a silent no-op')

  // queue: items play one after another, in order, on ONE engine process
  {
    const { fn, log } = fakeEngine(20)
    speech._setSpawn(fn)
    const tags = []
    speech.setOnStart((t) => tags.push(t))
    const all = await Promise.all([
      speech.speak('First one', { queue: true, tag: 'A' }),
      speech.speak('Second one', { queue: true, tag: 'B' }),
      speech.speak('Third one', { queue: true, tag: 'C' })
    ])
    assert.ok(all.every((r) => r.ok))
    assert.deepEqual(log.spoken, ['first one', 'second one', 'third one'])
    assert.deepEqual(tags, ['A', 'B', 'C'], 'caption tags are announced as each item starts')
    assert.equal(log.spawns, 1, 'a single long-lived engine, not one process per sentence')
    assert.equal(log.killed, 0)
    speech._kill()
  }

  // text containing newlines / protocol-looking words cannot inject commands (it travels as base64)
  {
    const { fn, log } = fakeEngine(5)
    speech._setSpawn(fn)
    await speech.speak('hello\nC\nS ZXZpbA==\nV evil', { queue: true })
    assert.equal(log.spoken.length, 1)
    assert.equal(log.cancels, 0)
    assert.deepEqual(log.voices, [])
    speech._kill()
  }

  // plain speak() interrupts the current sentence (cancel, no respawn) and drops the queue
  {
    const { fn, log } = fakeEngine(80)
    speech._setSpawn(fn)
    const first = speech.speak('long sentence one', { queue: true })
    const second = speech.speak('queued two', { queue: true })
    await wait(25)
    const now = speech.speak('stop everything and say this')
    assert.equal((await second).skipped, true, 'queued item was dropped')
    await Promise.all([first, now])
    assert.deepEqual(log.spoken, ['long sentence one', 'stop everything and say this'])
    assert.equal(log.cancels, 1)
    assert.equal(log.spawns, 1, 'cancelling does not restart the engine')
    speech._kill()
  }

  // urgent (a ringing call) cuts the sentence and goes first
  {
    const { fn, log } = fakeEngine(80)
    speech._setSpawn(fn)
    const a = speech.speak('some chat message', { queue: true })
    const b = speech.speak('another chat message', { queue: true })
    await wait(25)
    const u = speech.speak('x is calling you', { queue: true, urgent: true })
    await Promise.all([a, b, u])
    assert.equal(log.spoken[1], 'x is calling you')
    assert.ok(log.spoken.includes('another chat message'))
    assert.equal(log.cancels, 1)
    speech._kill()
  }

  // stop() silences and empties everything, and the engine is reused afterwards
  {
    const { fn, log } = fakeEngine(80)
    speech._setSpawn(fn)
    const a = speech.speak('one', { queue: true })
    const b = speech.speak('two', { queue: true })
    await wait(25)
    speech.stop()
    await Promise.all([a, b])
    assert.deepEqual(log.spoken, ['one'])
    await speech.speak('after stop')
    assert.equal(log.spawns, 1)
    assert.equal(log.spoken.at(-1), 'after stop')
    speech._kill()
  }

  // a stale cancel-timeout must never kill a NEWER sentence
  {
    const { fn, log } = fakeEngine(40)
    speech._setSpawn(fn)
    const a = speech.speak('first', { queue: true })
    await wait(15)
    speech.stop()
    await a
    const b = speech.speak('second sentence', { queue: true })
    await wait(1700) // longer than the 1.5 s safety timer
    await b
    assert.equal(log.killed, 0, 'engine was not killed by a stale safety timer')
    speech._kill()
  }

  // the queue is bounded
  {
    const { fn, log } = fakeEngine(5)
    speech._setSpawn(fn)
    const all = []
    for (let i = 0; i < MAX_QUEUE + 5; i++) all.push(speech.speak(`item ${i}`, { queue: true }))
    const res = await Promise.all(all)
    assert.ok(res.filter((r) => r.skipped).length >= 4, 'overflow dropped the oldest')
    speech._kill()
  }

  // the idle callback fires once the queue has drained
  {
    const { fn } = fakeEngine(10)
    speech._setSpawn(fn)
    let idle = 0
    speech.setOnIdle(() => idle++)
    await speech.speak('hello', { queue: true })
    await wait(30)
    assert.ok(idle >= 1, 'onIdle fired')
    speech.setOnIdle(null)
    speech._kill()
  }

  // an engine that dies is reported, and the next sentence starts a fresh one
  {
    let n = 0
    const base = fakeEngine(120) // the sentence takes 120 ms, the engine dies after 40 ms: it really does die mid-sentence
    speech._setSpawn((...a) => {
      n++
      const child = base.fn(...a)
      if (n === 1) setTimeout(() => child.kill(), 40)
      return child
    })
    const r1 = await speech.speak('dies midway', { queue: true })
    assert.equal(r1.ok, true, 'a dead engine resolves the sentence instead of hanging')
    const r2 = await speech.speak('second try', { queue: true })
    assert.equal(r2.ok, true)
    assert.equal(n, 2, 'a new engine was started')
    speech._kill()
  }

  // voices: pick by short name / gender / next / auto, and the chosen voice reaches the engine
  {
    speech._setVoices([
      { name: 'Microsoft David Desktop', short: 'David', gender: 'male', culture: 'en-US' },
      { name: 'Microsoft Zira Desktop', short: 'Zira', gender: 'female', culture: 'en-US' }
    ])
    assert.equal(speech.resolveVoice('zira').short, 'Zira')
    assert.equal(speech.resolveVoice('DAVID').name, 'Microsoft David Desktop')
    assert.equal(speech.resolveVoice('male').short, 'David')
    assert.equal(speech.resolveVoice('female').short, 'Zira')
    assert.equal(speech.resolveVoice('next', 'Microsoft David Desktop').short, 'Zira')
    assert.equal(speech.resolveVoice('next', 'Microsoft Zira Desktop').short, 'David', 'cycles back round')
    assert.equal(speech.resolveVoice('auto').name, '')
    assert.equal(speech.resolveVoice('klingon'), null)
    assert.equal(speech.shortName('Microsoft Zira Desktop - English (United States)'), 'Zira')
    speech.setVoice("x'; Remove-Item C:\\ -Recurse #")
    assert.equal(speech.getVoice(), '', 'a hostile voice name is rejected')

    const { fn, log } = fakeEngine(5)
    speech._setSpawn(fn)
    speech.setVoice('Microsoft Zira Desktop')
    await speech.speak('hi', { queue: true })
    assert.equal(log.env[0], 'Microsoft Zira Desktop', 'the voice is handed over when the engine starts')
    speech.setVoice('Microsoft David Desktop')
    await speech.speak('hi again', { queue: true })
    assert.deepEqual(log.voices, ['Microsoft David Desktop'], 'a voice change reaches the running engine')
    assert.equal(log.spawns, 1)
    speech.setVoice('')
    speech._kill()
  }

  speech._setSpawn(null)
  if (process.env.SPEECH_LIVE) {
    const r = await speech.speak('Hello. Karen here. Can you hear me?')
    assert.ok(r.ok, r.error)
    assert.ok(r.ms > 800, `real speech takes time, took ${r.ms} ms`)
    console.log(`live speech finished in ${r.ms} ms`)
    speech._kill()
  }
  console.log('speech: ALL PASS')
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
