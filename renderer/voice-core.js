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
  function resample(input, from, to = TARGET_RATE) {
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
   * The same band-limited resampler for a live stream: feed it microphone chunks as they come, take back 16 kHz samples.
   * It keeps the tail of the previous chunk, so there is no click at chunk borders (resampling every chunk on its own had one).
   */
  function createResampler(from, to = TARGET_RATE) {
    if (from === to) return { push: (c) => Float32Array.from(c) }
    const ratio = from / to
    const cutoff = Math.min(1, to / from)
    const half = Math.ceil(16 / cutoff)
    let buf = new Float32Array(0)
    let pos = 0
    return {
      push(chunk) {
        const joined = new Float32Array(buf.length + chunk.length)
        joined.set(buf)
        joined.set(chunk, buf.length)
        buf = joined
        const out = []
        for (;;) {
          const c = Math.floor(pos)
          if (c + half >= buf.length) break
          let acc = 0
          let wsum = 0
          for (let k = Math.max(0, c - half + 1); k <= c + half; k++) {
            const x = k - pos
            const sx = Math.PI * x * cutoff
            const w = (x === 0 ? 1 : Math.sin(sx) / sx) * 0.5 * (1 + Math.cos((Math.PI * x) / half)) * cutoff
            acc += buf[k] * w
            wsum += w
          }
          out.push(wsum ? acc / wsum : 0)
          pos += ratio
        }
        const drop = Math.max(0, Math.floor(pos) - half)
        if (drop > 0) {
          buf = buf.slice(drop)
          pos -= drop
        }
        return Float32Array.from(out)
      }
    }
  }
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
    const endSilenceMs = o.endSilenceMs ?? 1200
    const maxMs = o.maxMs ?? 15000
    const noSpeechMs = o.noSpeechMs ?? 6000
    let t = 0
    const calibLevels = []
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
          calibLevels.push(level)
          // the quiet end of what was heard (the start beep or an early word must not raise the bar)
          if (t + dtMs > calibMs) thr = Math.max(minThr, [...calibLevels].sort((x, y) => x - y)[Math.floor(calibLevels.length * 0.25)] * 3)
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

  return { resample, createResampler, encodeWav, rms, createVad, TARGET_RATE }
})
