'use strict'
/*
 * Pure helpers for talking to Jarvis: resampling, WAV encoding and the "has the person finished speaking?" detector.
 * No DOM, so they are unit-tested in plain Node; voice.js (browser) wires them to the microphone.
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.VoiceCore = factory()
})(this, function () {
  const TARGET_RATE = 16000

  /** linear resample of a mono Float32Array */
  function resample(input, fromRate, toRate = TARGET_RATE) {
    if (fromRate === toRate) return Float32Array.from(input)
    const ratio = fromRate / toRate
    const n = Math.max(0, Math.floor(input.length / ratio))
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const pos = i * ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(i0 + 1, input.length - 1)
      const f = pos - i0
      out[i] = input[i0] * (1 - f) + input[i1] * f
    }
    return out
  }

  /** mono float samples (-1..1) -> a complete 16-bit PCM WAV file */
  function encodeWav(samples, rate = TARGET_RATE) {
    const bytes = samples.length * 2
    const buf = new ArrayBuffer(44 + bytes)
    const v = new DataView(buf)
    const str = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
    }
    str(0, 'RIFF')
    v.setUint32(4, 36 + bytes, true)
    str(8, 'WAVE')
    str(12, 'fmt ')
    v.setUint32(16, 16, true) // PCM chunk size
    v.setUint16(20, 1, true) // PCM
    v.setUint16(22, 1, true) // mono
    v.setUint32(24, rate, true)
    v.setUint32(28, rate * 2, true) // byte rate
    v.setUint16(32, 2, true) // block align
    v.setUint16(34, 16, true) // bits per sample
    str(36, 'data')
    v.setUint32(40, bytes, true)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return new Uint8Array(buf)
  }

  const rms = (a) => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i] * a[i]
    return a.length ? Math.sqrt(s / a.length) : 0
  }

  /**
   * Decides when the person has started and finished speaking, from a stream of loudness readings.
   * feed(rms, dtMs) returns events: 'speech' (they started), 'end' (they stopped), 'timeout' (talked too long), 'nospeech' (silence).
   */
  function createVad(o = {}) {
    const calibMs = o.calibMs ?? 250
    const minThr = o.minThreshold ?? 0.012
    const startMs = o.startMs ?? 100
    const endSilenceMs = o.endSilenceMs ?? 1100
    const maxMs = o.maxMs ?? 15000
    const noSpeechMs = o.noSpeechMs ?? 6000
    let t = 0
    let calibSum = 0
    let calibN = 0
    let thr = minThr
    let loud = 0
    let quiet = 0
    let spoke = false
    let finished = false
    return {
      feed(level, dtMs) {
        if (finished) return []
        const ev = []
        t += dtMs
        if (t <= calibMs && !spoke) {
          calibSum += level
          calibN++
          if (t + dtMs > calibMs) thr = Math.max(minThr, (calibSum / Math.max(1, calibN)) * 2.8)
          return ev
        }
        if (level > thr) {
          loud += dtMs
          quiet = 0
          if (!spoke && loud >= startMs) {
            spoke = true
            ev.push('speech')
          }
        } else {
          if (!spoke) loud = 0
          if (spoke && level < thr * 0.8) quiet += dtMs
        }
        if (spoke && quiet >= endSilenceMs) {
          finished = true
          ev.push('end')
        } else if (t >= maxMs) {
          finished = true
          ev.push(spoke ? 'timeout' : 'nospeech')
        } else if (!spoke && t >= noSpeechMs) {
          finished = true
          ev.push('nospeech')
        }
        return ev
      },
      get threshold() {
        return thr
      },
      get spoke() {
        return spoke
      }
    }
  }

  return { resample, encodeWav, rms, createVad, TARGET_RATE }
})
