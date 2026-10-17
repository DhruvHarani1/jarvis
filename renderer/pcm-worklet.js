/* AudioWorklet: hands raw microphone samples to the page in small batches. Runs in the audio thread. */
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.batch = []
    this.frames = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) {
      this.batch.push(Float32Array.from(ch))
      this.frames += ch.length
      if (this.frames >= 2048) {
        const out = new Float32Array(this.frames)
        let o = 0
        for (const b of this.batch) {
          out.set(b, o)
          o += b.length
        }
        this.port.postMessage(out, [out.buffer])
        this.batch = []
        this.frames = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
