'use strict'
/** Small PCM helpers shared by the main process (no DOM, unit-tested). */

/**
 * 16-bit mono PCM WAV (as written by renderer/voice-core.js) to Float32 samples. Returns null for anything else.
 * @param {Buffer} wav
 * @returns {{samples:Float32Array, rate:number}|null}
 */
function wavToFloat32(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  let pos = 12
  let fmt = null
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4)
    const size = wav.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') fmt = { format: wav.readUInt16LE(body), channels: wav.readUInt16LE(body + 2), rate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) }
    else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) return null
      const end = Math.min(wav.length, body + size)
      const n = Math.floor((end - body) / 2)
      const samples = new Float32Array(n)
      for (let i = 0; i < n; i++) samples[i] = wav.readInt16LE(body + i * 2) / 32768
      return { samples, rate: fmt.rate }
    }
    pos = body + size + (size & 1)
  }
  return null
}

/** resample mono Float32 (band-limited, see below) */
function resample(input, from, to) {
  if (from === to) return Float32Array.from(input)
  // band-limited: a Hann-windowed sinc low-pass at the lower of the two Nyquist frequencies, so down-sampling 48 kHz to 16 kHz
  // does not fold high frequencies back into the voice band (plain interpolation did, adding a hiss that hurts recognition)
  const ratio = from / to
  const n = Math.max(0, Math.floor(input.length / ratio))
  const out = new Float32Array(n)
  const cutoff = Math.min(1, to / from)
  const half = Math.ceil(16 / cutoff)
  for (let i = 0; i < n; i++) {
    const center = i * ratio
    const c = Math.floor(center)
    let acc = 0
    let wsum = 0
    for (let k = Math.max(0, c - half + 1); k <= Math.min(input.length - 1, c + half); k++) {
      const x = k - center
      const sx = Math.PI * x * cutoff
      const w = (x === 0 ? 1 : Math.sin(sx) / sx) * 0.5 * (1 + Math.cos((Math.PI * x) / half)) * cutoff
      acc += input[k] * w
      wsum += w
    }
    out[i] = wsum ? acc / wsum : 0
  }
  return out
}

/**
 * Cut the silence/room noise before and after the speech (Moonshine answers nothing when a clip starts with seconds of noise).
 * Energy based: the quiet level is learned from the clip itself. Returns the input unchanged when no speech is found.
 */
function trimSilence(samples, rate = 16000, { padStartMs = 400, padEndMs = 500, minRms = 0.006 } = {}) {
  const frame = Math.round(rate * 0.02)
  const n = Math.floor(samples.length / frame)
  if (n < 5) return samples
  const rms = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i]
    rms[f] = Math.sqrt(sum / frame)
  }
  const sorted = Array.from(rms).sort((a, b) => a - b)
  const floor = sorted[Math.floor(n * 0.1)]
  const threshold = Math.max(minRms, floor * 3.5) // low minimum: a quiet speaker on a laptop microphone must not be cut off
  let first = -1
  let last = -1
  for (let f = 0; f < n; f++) {
    // two loud frames in a row, so a click is not mistaken for speech
    if (rms[f] > threshold && rms[Math.min(n - 1, f + 1)] > threshold) {
      if (first < 0) first = f
      last = f + 1
    }
  }
  if (first < 0) return samples
  const start = Math.max(0, first * frame - Math.round((padStartMs * rate) / 1000))
  const end = Math.min(samples.length, (last + 1) * frame + Math.round((padEndMs * rate) / 1000))
  return samples.subarray(start, end)
}

/**
 * Bring a quiet recording up to a level the recogniser likes (never louder than 6x, and loud recordings are left alone).
 * Looks at the 99th percentile of the loudness, not the single loudest sample, so one click does not stop the boost.
 */
function normalize(samples, target = 0.4, maxGain = 6) {
  if (samples.length < 100) return samples
  const step = Math.max(1, Math.floor(samples.length / 8000))
  const a = []
  for (let i = 0; i < samples.length; i += step) a.push(Math.abs(samples[i]))
  a.sort((x, y) => x - y)
  const p99 = a[Math.floor(a.length * 0.99)]
  if (!(p99 > 0.002) || p99 >= 0.25) return samples
  const g = Math.min(maxGain, target / p99)
  if (g < 1.15) return samples
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] * g))
  return out
}

module.exports = { wavToFloat32, resample, trimSilence, normalize }
