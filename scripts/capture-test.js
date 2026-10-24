'use strict'
// The capture pipeline (V3): band-limited resampling (offline and streaming), level normalisation, gentle silence trimming, robust VAD calibration.
const assert = require('node:assert/strict')
const pcm = require('../audio/pcm')
const VC = require('../renderer/voice-core')

const tone = (hz, rate, secs, amp = 0.5) => Float32Array.from({ length: Math.round(rate * secs) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate))
const rmsOf = (a, from = 0, to = a.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += a[i] * a[i]
  return Math.sqrt(s / Math.max(1, to - from))
}
const linear = (input, from, to) => {
  const ratio = from / to
  const n = Math.floor(input.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * ratio
    const a = Math.floor(p)
    out[i] = input[a] + ((input[a + 1] === undefined ? input[a] : input[a + 1]) - input[a]) * (p - a)
  }
  return out
}

// ---- resampling keeps the voice band and removes what 16 kHz cannot hold (plain interpolation folded it back as hiss)
for (const resample of [pcm.resample, VC.resample]) {
  const voice = resample(tone(1000, 48000, 1), 48000, 16000)
  assert.equal(voice.length, 16000)
  assert.ok(Math.abs(rmsOf(voice, 2000, 14000) - 0.5 / Math.SQRT2) < 0.01, 'a 1 kHz tone keeps its level')
  const ultra = resample(tone(11000, 48000, 1), 48000, 16000) // above the new 8 kHz limit: must vanish, not alias to 5 kHz
  assert.ok(rmsOf(ultra, 2000, 14000) < 0.02, 'an 11 kHz tone is removed (rms ' + rmsOf(ultra, 2000, 14000).toFixed(3) + ')')
  const aliased = linear(tone(11000, 48000, 1), 48000, 16000)
  assert.ok(rmsOf(aliased, 2000, 14000) > 0.2, 'the old linear resampler let it through as an alias (this is what was fixed)')
  const up = resample(tone(1000, 16000, 1), 16000, 48000)
  assert.equal(up.length, 48000)
  assert.ok(Math.abs(rmsOf(up, 6000, 42000) - 0.5 / Math.SQRT2) < 0.01, 'up-sampling keeps the tone too')
  assert.equal(resample(Float32Array.of(1, 2, 3), 16000, 16000).join(), '1,2,3')
  assert.equal(resample(new Float32Array(0), 48000, 16000).length, 0)
  const dc = resample(new Float32Array(4800).fill(0.3), 48000, 16000)
  assert.ok(Math.abs(dc[800] - 0.3) < 1e-3 && Math.abs(dc[0] - 0.3) < 0.02, 'a flat level stays flat, including at the edges')
}
const noise = Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 7) * 0.4 + Math.sin(i / 3) * 0.2)
const a = pcm.resample(noise, 22050, 16000)
const b = VC.resample(noise, 22050, 16000)
assert.equal(a.length, b.length)
assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-6), 'the main process and the window use the same resampler')

// ---- streaming: chunk by chunk gives the same samples as all at once (no clicks at the borders)
{
  const sig = Float32Array.from({ length: 48000 }, (_, i) => 0.3 * Math.sin(i / 11) + 0.2 * Math.sin(i / 97) + 0.1 * Math.sin(i / 3.3))
  const whole = VC.resample(sig, 48000, 16000)
  const rs = VC.createResampler(48000, 16000)
  const parts = []
  for (let i = 0, step = 1; i < sig.length; i += step, step = (step * 7 + 313) % 2500 + 1) parts.push(rs.push(sig.subarray(i, i + step)))
  const streamed = Float32Array.from(parts.flatMap((p) => [...p]))
  assert.ok(streamed.length >= whole.length - 60 && streamed.length <= whole.length, `same length up to the filter delay (${streamed.length} vs ${whole.length})`)
  let worst = 0
  for (let i = 100; i < streamed.length - 100; i++) worst = Math.max(worst, Math.abs(streamed[i] - whole[i]))
  assert.ok(worst < 0.01, 'streaming equals offline, worst difference ' + worst.toFixed(5))
  assert.equal(VC.createResampler(16000, 16000).push(Float32Array.of(1, 2)).join(), '1,2')
}

// ---- normalisation: quiet voices are lifted, loud ones left alone, silence is not turned into noise
{
  const quiet = tone(300, 16000, 1, 0.04)
  const n = pcm.normalize(quiet)
  let peak = 0
  for (const v of n) peak = Math.max(peak, Math.abs(v))
  assert.ok(peak > 0.2 && peak <= 0.3, 'a quiet voice is raised about 6x (peak ' + peak.toFixed(2) + ')')
  const loud = tone(300, 16000, 1, 0.6)
  assert.equal(pcm.normalize(loud), loud, 'a loud recording is returned untouched')
  const hiss = Float32Array.from({ length: 16000 }, () => (Math.random() - 0.5) * 0.002)
  assert.equal(pcm.normalize(hiss), hiss, 'near-silence is not amplified into noise')
  const click = tone(300, 16000, 1, 0.05)
  click[8000] = 0.99
  const c2 = pcm.normalize(click)
  assert.ok(c2 !== click && rmsOf(c2) > rmsOf(click) * 3, 'one loud click does not stop the boost')
  assert.ok(pcm.normalize(Float32Array.of(0.01, 0.01)).length === 2)
}

// ---- trimming keeps a quiet speaker (the old floor of 0.012 cut them off)
{
  const R = 16000
  const clip = new Float32Array(R * 4)
  for (let i = 0; i < clip.length; i++) clip[i] = (Math.random() - 0.5) * 0.004 // room
  for (let i = R * 1.5; i < R * 2.5; i++) clip[i] = Math.sin(i / 9) * 0.02 * (0.6 + 0.4 * Math.sin(i / 3000)) // a soft voice, rms about 0.012
  const cut = pcm.trimSilence(clip, R)
  assert.ok(cut.length >= R * 1.0 && cut.length < R * 2.2, `speech kept with room around it (${(cut.length / R).toFixed(2)} s)`)
  assert.ok(rmsOf(cut) > 0.004, 'the soft voice is inside the cut (rms ' + rmsOf(cut).toFixed(4) + ')')
  assert.ok(rmsOf(cut, Math.floor(cut.length * 0.3), Math.floor(cut.length * 0.7)) > 0.005, 'and it is the middle of the cut, not just room noise')
}

// ---- VAD: a beep at the start and an early word do not raise the bar for the rest
{
  const mk = () => VC.createVad({ noSpeechMs: 6000 })
  const feedAll = (vad, levels, dt = 50) => levels.flatMap((l) => vad.feed(l, dt))
  const room = 0.004
  const speech = 0.05
  // 250 ms of calibration: room, a beep at 0.06 for 150 ms, then speech from the start of a soft word
  const levels = [0.06, 0.06, 0.06, room, room, ...Array(12).fill(speech), ...Array(30).fill(room)]
  const ev = feedAll(mk(), levels)
  assert.ok(ev.includes('speech') && ev.includes('end'), 'speech after a beep is heard and ends: ' + ev.join(','))
  // a long pause in the middle of a sentence (1.0 s) does not end it; 1.3 s does
  const gap = (ms) => [...Array(5).fill(room), ...Array(10).fill(speech), ...Array(ms / 50).fill(room), ...Array(10).fill(speech), ...Array(30).fill(room)]
  const evShort = []
  const v = mk()
  gap(1000).forEach((l, i) => v.feed(l, 50).forEach((e) => evShort.push([e, i])))
  assert.ok(evShort.find(([e]) => e === 'end')[1] > 25, 'a one second pause does not end the sentence')
  // pure silence gives up
  assert.ok(feedAll(mk(), Array(140).fill(room)).includes('nospeech'))
}

// ---- Voice Lab helpers: word error rate and the microphone check
{
  assert.equal(VC.wer('what is my cpu', 'What is my CPU?'), 0)
  assert.equal(VC.wer('open whatsapp', "open what's app"), 1)
  assert.equal(VC.wer('send a message to mum', 'send message to mum'), 0.2)
  assert.equal(VC.wer('', ''), 0)
  assert.equal(VC.wer('hello', ''), 1)
  const R = 16000
  const room = (secs, amp) => Float32Array.from({ length: R * secs }, () => (Math.random() - 0.5) * amp)
  const voice = (secs, amp) => Float32Array.from({ length: R * secs }, (_, i) => amp * Math.sin(i / 9) * (0.6 + 0.4 * Math.sin(i / 2000)))
  const good = VC.analyzeMic(room(2, 0.004), voice(3, 0.3))
  assert.equal(good.findings[0].level, 'ok', JSON.stringify(good.findings))
  const quiet = VC.analyzeMic(room(2, 0.004), voice(3, 0.015))
  assert.ok(quiet.findings.some((x) => /quiet/.test(x.text)), JSON.stringify(quiet.findings))
  const dead = VC.analyzeMic(room(2, 0.004), room(3, 0.004))
  assert.equal(dead.findings[0].level, 'bad')
  const noisy = VC.analyzeMic(room(2, 0.2), voice(3, 0.3))
  assert.ok(noisy.findings.some((x) => /noisy/.test(x.text)), JSON.stringify(noisy.findings))
  const loud = voice(3, 1.2).map((v) => Math.max(-1, Math.min(1, v)))
  assert.ok(VC.analyzeMic(room(2, 0.004), loud).findings.some((x) => /too loud/.test(x.text)))
}

console.log('capture: ALL PASS')
