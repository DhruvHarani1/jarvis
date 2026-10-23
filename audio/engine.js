'use strict'
/**
 * The local audio brain: speech to text (Moonshine), text to speech (Piper through sherpa-onnx) and the wake word
 * (sherpa-onnx keyword spotter). Runs inside the audio worker process, never in the main process.
 *
 * Each part is loaded the first time it is used and can be unloaded to give the RAM back. Everything that touches the
 * outside (sherpa, the phonemizer, model folders) is injected, so the logic is unit-tested without any model.
 */
const fs = require('node:fs')
const path = require('node:path')
const { trimSilence } = require('./pcm')

const SAMPLE_RATE = 16000
const MAX_TTS_CHARS = 600

function create({ sherpa, models, requirePhonemizer, threads = 2, now = Date.now }) {
  let recognizer = null
  let tts = null
  let phon = null
  let kws = null
  let kwsStream = null

  // ------------------------------------------------------------------ speech to text
  function loadStt() {
    if (recognizer) return recognizer
    const dir = models.locate('stt')
    if (!dir) throw new Error('speech model not installed')
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        moonshine: { encoder: path.join(dir, 'encoder_model.ort'), mergedDecoder: path.join(dir, 'decoder_model_merged.ort') },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: threads,
        provider: 'cpu'
      }
    })
    return recognizer
  }

  /** @param {Float32Array} samples 16 kHz mono, -1..1 */
  function transcribe(samples) {
    const t0 = now()
    const r = loadStt()
    const decode = (x) => {
      const s = r.createStream()
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: x })
      r.decode(s)
      return String(r.getResult(s).text || '').trim()
    }
    // speech only (seconds of room noise before it make the model answer nothing); if that still gives nothing, try the whole clip
    const cut = trimSilence(samples, SAMPLE_RATE)
    let text = decode(cut)
    if (!text && cut.length !== samples.length) text = decode(samples)
    return { text, ms: now() - t0, seconds: cut.length / SAMPLE_RATE }
  }

  // ------------------------------------------------------------------ text to speech
  function loadTts() {
    if (tts) return tts
    const dir = models.locate('voice')
    const pdir = models.locate('phonemizer')
    if (!dir || !pdir) throw new Error('voice model not installed')
    const onnx = fs.readdirSync(dir).find((f) => f.endsWith('.onnx'))
    if (!onnx) throw new Error('voice model folder is incomplete')
    phon = requirePhonemizer(pdir)
    tts = new sherpa.OfflineTts({
      model: { vits: { model: path.join(dir, onnx), tokens: path.join(dir, 'tokens.txt') }, numThreads: threads, provider: 'cpu' },
      maxNumSentences: 1
    })
    return tts
  }

  /** one short piece of text in, PCM out */
  function synth(text, { speed = 1.0, sid = 0 } = {}) {
    const t0 = now()
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TTS_CHARS)
    if (!clean) return { samples: new Float32Array(0), rate: 22050, ms: 0 }
    const v = loadTts()
    // the phonemizer splits sentences; the C API refuses empty ones
    const phonemeCodepoints = phon.phonemize(clean, v.lang || 'en-us').filter((x) => x.length > 0)
    if (!phonemeCodepoints.length) return { samples: new Float32Array(0), rate: v.sampleRate, ms: 0 }
    // enableExternalBuffer:false - Electron's V8 refuses buffers owned by native code ("External buffers are not allowed")
    const a = v.generate({ text: '', enableExternalBuffer: false, generationConfig: new sherpa.GenerationConfig({ phonemeCodepoints, sid, speed, silenceScale: 0.2 }) })
    return { samples: a.samples, rate: a.sampleRate, ms: now() - t0 }
  }

  // ------------------------------------------------------------------ wake word
  function loadKws() {
    if (kws) return kws
    const dir = models.locate('wake')
    if (!dir) throw new Error('wake word model not installed')
    const f = (n) => path.join(dir, `${n}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`)
    kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: { transducer: { encoder: f('encoder'), decoder: f('decoder'), joiner: f('joiner') }, tokens: path.join(dir, 'tokens.txt'), numThreads: 1, provider: 'cpu' },
      keywordsFile: path.join(__dirname, 'keywords.txt'),
      keywordsScore: 1.0,
      keywordsThreshold: 0.25
    })
    kwsStream = kws.createStream()
    return kws
  }

  /** feed 16 kHz microphone samples; returns the detected keyword name or '' */
  function feedWake(samples) {
    const k = loadKws()
    kwsStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    let hit = ''
    while (k.isReady(kwsStream)) {
      k.decode(kwsStream)
      const r = k.getResult(kwsStream).keyword
      if (r && !hit) hit = r
    }
    if (hit) kwsStream = k.createStream() // start fresh after a detection
    return hit
  }
  function resetWake() {
    if (kws) kwsStream = kws.createStream()
  }

  function unload(what = 'all') {
    if (what === 'all' || what === 'stt') recognizer = null
    if (what === 'all' || what === 'tts') {
      tts = null
      phon = null
    }
    if (what === 'all' || what === 'wake') {
      kws = null
      kwsStream = null
    }
  }
  const loaded = () => ({ stt: !!recognizer, tts: !!tts, wake: !!kws })

  return { transcribe, synth, feedWake, resetWake, unload, loaded, SAMPLE_RATE }
}

module.exports = { create, SAMPLE_RATE, MAX_TTS_CHARS }
