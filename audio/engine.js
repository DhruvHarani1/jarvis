'use strict'
/**
 * The local audio brain: speech to text (Moonshine), text to speech (Piper through sherpa-onnx) and the wake word
 * (sherpa-onnx keyword spotter). Runs inside the audio worker process, never in the main process.
 *
 * Each part is loaded the first time it is used and can be unloaded to give the RAM back. Everything that touches the
 * outside (sherpa, the phonemizer, model folders) is injected, so the logic is unit-tested without any model.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { trimSilence, normalize } = require('./pcm')

const SAMPLE_RATE = 16000
const MAX_TTS_CHARS = 600

// "Hey/Okay Jarvis" spelled the way the keyword model's vocabulary splits it. boost = how hard the phrase is pushed, threshold = how sure
// the model must be. Chosen with scripts/spikes/wake-sweep.js; the Voice Lab picks one on the person's own voice.
const WAKE_TOKENS = { HEY_JARVIS: '▁HE Y ▁JA R VI S', OKAY_JARVIS: '▁OKAY ▁JA R VI S' }
const WAKE_PRESETS = {
  low: { boost: 2.5, threshold: 0.15 }, // fewest false wake-ups, misses quiet or fast speech more
  normal: { boost: 3.5, threshold: 0.05 },
  high: { boost: 4.5, threshold: 0.02 } // catches the most, may wake on look-alikes
}
const wakeKeywords = (preset) => {
  const p = WAKE_PRESETS[preset] || WAKE_PRESETS.normal
  return Object.entries(WAKE_TOKENS).map(([name, t]) => `${t} :${p.boost} #${p.threshold} @${name}`).join(String.fromCharCode(10)) + String.fromCharCode(10)
}

function create({ sherpa, models, requirePhonemizer, threads = 2, now = Date.now }) {
  let tts = null
  let phon = null
  let kws = null
  let kwsStream = null
  let wakePreset = 'normal'

  // ------------------------------------------------------------------ speech to text
  // two models: Moonshine (small, fast) and NVIDIA Parakeet (large, much more accurate, takes hotwords)
  const recognizers = {}
  function loadStt(kind) {
    if (recognizers[kind]) return recognizers[kind]
    if (kind === 'parakeet') {
      const dir = models.locate('stt-parakeet')
      if (!dir) throw new Error('Parakeet speech model not installed')
      // hotwords need a BPE vocabulary; the release does not ship one, but it can be derived from tokens.txt
      const vocab = path.join(dir, 'bpe.vocab')
      if (!fs.existsSync(vocab)) {
        const tokens = fs.readFileSync(path.join(dir, 'tokens.txt'), 'utf8')
        fs.writeFileSync(vocab, tokens.split('\n').filter((l) => l.trim()).map((l) => l.split(' ')[0] + '\t-1.0').join('\n') + '\n')
      }
      recognizers[kind] = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') },
          tokens: path.join(dir, 'tokens.txt'),
          numThreads: threads,
          provider: 'cpu',
          modelType: 'nemo_transducer',
          modelingUnit: 'bpe',
          bpeVocab: vocab
        },
        decodingMethod: 'modified_beam_search',
        hotwordsScore: 2.0
      })
      return recognizers[kind]
    }
    const dir = models.locate('stt')
    if (!dir) throw new Error('speech model not installed')
    recognizers[kind] = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        moonshine: { encoder: path.join(dir, 'encoder_model.ort'), mergedDecoder: path.join(dir, 'decoder_model_merged.ort') },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: threads,
        provider: 'cpu'
      }
    })
    return recognizers[kind]
  }

  /**
   * @param {Float32Array} samples 16 kHz mono, -1..1
   * @param {{model?:'moonshine'|'parakeet', hotwords?:string}} [o] hotwords: words to favour, separated by "/" (Parakeet only)
   */
  function transcribe(samples, { model = 'moonshine', hotwords = '' } = {}) {
    const t0 = now()
    const kind = model === 'parakeet' ? 'parakeet' : 'moonshine'
    const r = loadStt(kind)
    const decode = (x) => {
      const s = kind === 'parakeet' && hotwords ? r.createStream(hotwords) : r.createStream()
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: x })
      r.decode(s)
      return String(r.getResult(s).text || '').trim()
    }
    // speech only (seconds of room noise before it make the model answer nothing); if that still gives nothing, try the whole clip
    const cut = normalize(trimSilence(samples, SAMPLE_RATE))
    let text = decode(cut)
    if (!text && cut.length !== samples.length) text = decode(samples)
    return { text, ms: now() - t0, seconds: cut.length / SAMPLE_RATE, model: kind }
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
  // one spotter per preset (the native library takes boost and threshold only from a keywords file, not per stream)
  const spotters = {}
  function spotter(preset) {
    if (spotters[preset]) return spotters[preset]
    const dir = models.locate('wake')
    if (!dir) throw new Error('wake word model not installed')
    const f = (n) => path.join(dir, `${n}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`)
    const kdir = path.join(os.tmpdir(), 'jarvis-wake-keywords')
    fs.mkdirSync(kdir, { recursive: true })
    const kfile = path.join(kdir, preset + '.txt')
    fs.writeFileSync(kfile, wakeKeywords(preset))
    spotters[preset] = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: { transducer: { encoder: f('encoder'), decoder: f('decoder'), joiner: f('joiner') }, tokens: path.join(dir, 'tokens.txt'), numThreads: 1, provider: 'cpu' },
      keywordsFile: kfile,
      keywordsScore: 1.0,
      keywordsThreshold: WAKE_PRESETS[preset].threshold
    })
    return spotters[preset]
  }
  function loadKws() {
    if (kws) return kws
    kws = spotter(wakePreset)
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
  /** 'low' | 'normal' | 'high' */
  function setWakePreset(name) {
    if (!WAKE_PRESETS[name]) return false
    wakePreset = name
    if (kws) {
      kws = spotter(name)
      kwsStream = kws.createStream()
    }
    return true
  }
  /** how many times each preset would have woken on this recording (16 kHz mono) */
  function wakeTest(samples) {
    const out = {}
    for (const name of Object.keys(WAKE_PRESETS)) {
      const k = spotter(name)
      const st = k.createStream()
      let n = 0
      const pump = () => {
        while (k.isReady(st)) {
          k.decode(st)
          if (k.getResult(st).keyword) n++
        }
      }
      for (let i = 0; i < samples.length; i += 1600) {
        st.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: samples.subarray(i, i + 1600) })
        pump()
      }
      st.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(8000) }) // let the last word finish
      pump()
      out[name] = n
    }
    return out
  }

  function unload(what = 'all') {
    if (what === 'all' || what === 'stt') for (const k of Object.keys(recognizers)) delete recognizers[k]
    if (what === 'all' || what === 'tts') {
      tts = null
      phon = null
    }
    if (what === 'all' || what === 'wake') {
      kws = null
      kwsStream = null
      for (const k of Object.keys(spotters)) delete spotters[k]
    }
  }
  const loaded = () => ({ stt: !!recognizers.moonshine, parakeet: !!recognizers.parakeet, tts: !!tts, wake: !!kws })

  return { transcribe, synth, feedWake, resetWake, setWakePreset, wakeTest, unload, loaded, SAMPLE_RATE }
}

module.exports = { create, SAMPLE_RATE, MAX_TTS_CHARS, WAKE_PRESETS, wakeKeywords }
