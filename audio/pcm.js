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

/** linear resample of mono Float32 */
function resample(input, from, to) {
  if (from === to) return Float32Array.from(input)
  const ratio = from / to
  const n = Math.max(0, Math.floor(input.length / ratio))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * ratio
    const a = Math.floor(p)
    out[i] = input[a] + ((input[a + 1] === undefined ? input[a] : input[a + 1]) - input[a]) * (p - a)
  }
  return out
}

/**
 * Cut the silence/room noise before and after the speech (Moonshine answers nothing when a clip starts with seconds of noise).
 * Energy based: the quiet level is learned from the clip itself. Returns the input unchanged when no speech is found.
 */
function trimSilence(samples, rate = 16000, { padStartMs = 250, padEndMs = 350 } = {}) {
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
  const threshold = Math.max(0.012, floor * 4)
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

module.exports = { wavToFloat32, resample, trimSilence }
