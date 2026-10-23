'use strict'
/**
 * Jarvis's brain: a failover chain of AI providers.
 *
 *   key 1 → key 2 → key 3  (up to three online attempts per question)  →  local Ollama  →  "offline" (Jarvis's rule engine)
 *
 * - Every provider speaks the OpenAI-compatible chat API, so NVIDIA, Groq, Gemini, OpenRouter, your own URL and Ollama share one code path.
 * - A key that hits its limit (429) or errors is put in a cooldown and skipped; a rejected key (401/403) is marked bad until you change it.
 * - Keys are encrypted at rest with Windows DPAPI (Electron safeStorage). If encryption is not available they are NOT saved.
 * - fetch / clock / crypto / storage are injected, so the whole thing is unit-tested without a network.
 */
const fs = require('node:fs')
const path = require('node:path')

const MAX_ONLINE_TRIES = 3
const ONLINE_TIMEOUT_MS = 25_000
const LOCAL_TIMEOUT_MS = 70_000
const MAX_ENTRIES = 12
const OLLAMA_BASE = 'http://127.0.0.1:11434/v1'
const MAX_MODEL_TRIES = 6
const STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3']
// a hint that biases Whisper toward the words Jarvis actually hears
const STT_PROMPT = 'Jarvis, WhatsApp, reminder, notifications, CPU, RAM, timer, Dhruv.'
const ONLINE_STREAM_MS = 60_000
const FIRST_TOKEN_MS = 20_000
const MAX_CANDIDATES = 14
// text chat models only: skip embeddings, rerankers, safety guards, vision/image/audio/bio models …
const BAD_MODEL = /embed|rerank|guard|safety|reward|retriev|vision|(^|[-/])vl([-/]|$)|image|video|clip|ocr|asr|tts|speech|whisper|biolog|protein|molecul|diffusion|parse|moderat|audio|translat|riva|calibrat|genmol|fourcastnet|flux|sdxl|stable|code-?gen|nemoguard|content-safety/i
const GOOD_HINT = /instruct|chat|flash|lightning|nemotron|llama|qwen|gemma|mistral|gpt-oss|deepseek|phi|glm|kimi|minimax|granite|-it$|versatile|instant|sonar|command|grok/i
const SMALL_HINT = /(^|[^0-9])(1|3|4|7|8|9|12)b(?![0-9])|lightning|flash|mini|small|instant|lite/i

/** Presets: base URL, models we prefer (the first one the key can actually see is used), and where to get a free key. */
const PRESETS = {
  nvidia: {
    name: 'NVIDIA (build.nvidia.com)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct', 'meta/llama-3.1-8b-instruct', 'deepseek-ai/deepseek-v3.1'],
    signup: 'https://build.nvidia.com/',
    hint: 'Free key starting nvapi-… (about 40 requests/min). Terms: prototyping use.'
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'qwen/qwen3-32b'],
    signup: 'https://console.groq.com/keys',
    hint: 'Free, very fast. Key starts gsk_…'
  },
  gemini: {
    name: 'Google Gemini (AI Studio)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    signup: 'https://aistudio.google.com/apikey',
    hint: 'Free, no card. The free tier may be used to improve Google’s models.'
  },
  openrouter: {
    name: 'OpenRouter (free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free', 'meta-llama/llama-3.3-70b-instruct:free'],
    signup: 'https://openrouter.ai/keys',
    hint: 'Free models end in :free (about 20 requests/min, 50/day; 1000/day after a one-time $10 top-up).'
  },
  custom: {
    name: 'Custom (any OpenAI-compatible URL)',
    baseUrl: '',
    models: [],
    signup: '',
    hint: 'Mistral, Together, Cerebras, a self-hosted server… anything with /chat/completions.'
  }
}

// ------------------------------------------------------------------ validation
function cleanBaseUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '')
  if (!u || u.length > 200) return ''
  let parsed
  try {
    parsed = new URL(u)
  } catch {
    return ''
  }
  if (parsed.username || parsed.password) return ''
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) return u
  return ''
}
const cleanKey = (k) => (/^[\w\-.:+=/~]{8,400}$/.test(String(k || '')) ? String(k) : '')
const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n)
const last4 = (k) => (k.length > 8 ? `…${k.slice(-4)}` : '…')

// ------------------------------------------------------------------ error classification
/** @returns {{kind:'auth'|'rate'|'server'|'model'|'client'|'timeout'|'network', retryAfterMs?:number, message:string}} */
function classify(status, headers, bodyText, err) {
  if (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError' || /timed? ?out/i.test(String(err.message))
    return { kind: timeout ? 'timeout' : 'network', message: timeout ? 'no answer in time' : 'could not reach the server' }
  }
  const msg = (() => {
    try {
      const j = JSON.parse(bodyText)
      return String(j.error?.message || j.error || j.message || bodyText).slice(0, 160)
    } catch {
      return String(bodyText || '').slice(0, 160)
    }
  })()
  if (status === 401 || status === 403) return { kind: 'auth', message: 'the key was rejected' }
  if (status === 429) {
    const ra = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null
    let ms
    if (ra) {
      const secs = Number(ra)
      ms = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(ra) - Date.now())
    }
    return { kind: 'rate', retryAfterMs: Number.isFinite(ms) ? ms : undefined, message: 'rate limit reached' }
  }
  if (status === 404 || (status === 400 && /model/i.test(msg))) return { kind: 'model', message: `model problem: ${msg}` }
  if (status >= 500) return { kind: 'server', message: `provider error ${status}` }
  return { kind: 'client', message: `error ${status}: ${msg}` }
}

/** OpenAI-style reply -> plain text (some providers send content parts) */
function extractText(json) {
  const c = json?.choices?.[0]?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
  return ''
}

/** OpenAI-style reply -> [{id,name,arguments}] (arguments stay the JSON text the model wrote) */
function extractToolCalls(json) {
  const calls = json?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(calls)) return []
  return calls
    .filter((c) => c && c.function && typeof c.function.name === 'string')
    .map((c, i) => ({ id: String(c.id || 'call_' + (i + 1)), name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) }))
}

// ------------------------------------------------------------------ the brain
/**
 * @param {{ file:string, fetch:typeof fetch, now?:()=>number, crypt:{available:()=>boolean, enc:(s:string)=>string, dec:(s:string)=>string}, ollama?:{status:()=>Promise<{available:boolean, model:string}>} }} deps
 */
function createBrain(deps) {
  const { file, crypt } = deps
  const doFetch = deps.fetch
  const now = deps.now || Date.now
  /** @type {{naturalChat:boolean, entries:any[]}} */
  let store = { naturalChat: true, entries: [] }
  /** runtime state per entry id: fails, until (cooldown end), bad, lastError, lastOk, model */
  const rt = new Map()
  let lastChain = []

  // ---------- persistence
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j && Array.isArray(j.entries)) store = { naturalChat: j.naturalChat !== false, entries: j.entries.filter((e) => e && e.id && PRESETS[e.provider] && typeof e.enc === 'string').slice(0, MAX_ENTRIES) }
    } catch {
      /* first run */
    }
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...store }, null, 2))
  }
  load()

  const state = (id) => {
    if (!rt.has(id)) rt.set(id, { fails: 0, until: 0, bad: false, lastError: '', lastOk: 0, model: '', badModels: new Set(), cands: null, candsAt: 0 })
    return rt.get(id)
  }
  const keyOf = (e) => {
    try {
      return crypt.dec(e.enc)
    } catch {
      return ''
    }
  }
  const find = (id) => store.entries.find((e) => e.id === id)

  // ---------- public listing (never includes the key itself)
  function list() {
    return store.entries.map((e) => {
      const s = state(e.id)
      const cooling = s.until > now()
      return {
        id: e.id,
        provider: e.provider,
        providerName: PRESETS[e.provider].name,
        label: e.label,
        model: e.model || s.model || '',
        baseUrl: e.baseUrl || PRESETS[e.provider].baseUrl,
        keyHint: e.hint || '…',
        enabled: e.enabled !== false,
        status: s.bad ? 'bad' : cooling ? 'cooling' : s.lastOk ? 'ok' : 'untested',
        cooldownS: cooling ? Math.ceil((s.until - now()) / 1000) : 0,
        lastError: s.lastError
      }
    })
  }
  const getSettings = () => ({ naturalChat: store.naturalChat, canEncrypt: !!crypt.available() })

  // ---------- editing
  function add({ provider, key, label, model, baseUrl }) {
    if (!PRESETS[provider]) throw new Error('unknown provider')
    if (store.entries.length >= MAX_ENTRIES) throw new Error('too many keys')
    const k = cleanKey(key)
    if (!k) throw new Error('that does not look like an API key')
    if (!crypt.available()) throw new Error('Windows encryption is unavailable, so I will not store the key')
    const url = provider === 'custom' ? cleanBaseUrl(baseUrl) : ''
    if (provider === 'custom' && !url) throw new Error('enter a valid https:// base URL')
    const entry = {
      id: Math.random().toString(36).slice(2, 10),
      provider,
      label: cleanText(label, 40) || `${PRESETS[provider].name.split(' ')[0]} ${store.entries.filter((e) => e.provider === provider).length + 1}`,
      model: cleanText(model, 80),
      baseUrl: url,
      enc: crypt.enc(k),
      hint: last4(k),
      enabled: true
    }
    store.entries.push(entry)
    save()
    return entry.id
  }

  function update(id, patch) {
    const e = find(id)
    if (!e) throw new Error('no such key')
    if (patch.label !== undefined) e.label = cleanText(patch.label, 40) || e.label
    if (patch.model !== undefined) {
      e.model = cleanText(patch.model, 80)
      Object.assign(state(id), { model: '', cands: null, badModels: new Set() })
    }
    if (patch.enabled !== undefined) e.enabled = !!patch.enabled
    if (patch.baseUrl !== undefined && e.provider === 'custom') {
      const url = cleanBaseUrl(patch.baseUrl)
      if (!url) throw new Error('enter a valid https:// base URL')
      e.baseUrl = url
    }
    if (patch.key) {
      const k = cleanKey(patch.key)
      if (!k) throw new Error('that does not look like an API key')
      if (!crypt.available()) throw new Error('Windows encryption is unavailable')
      e.enc = crypt.enc(k)
      e.hint = last4(k)
      Object.assign(state(id), { bad: false, fails: 0, until: 0, lastError: '', model: '', cands: null, badModels: new Set() })
    }
    save()
  }

  function remove(id) {
    store.entries = store.entries.filter((e) => e.id !== id)
    rt.delete(id)
    save()
  }

  function move(id, dir) {
    const i = store.entries.findIndex((e) => e.id === id)
    const j = i + (dir < 0 ? -1 : 1)
    if (i < 0 || j < 0 || j >= store.entries.length) return
    ;[store.entries[i], store.entries[j]] = [store.entries[j], store.entries[i]]
    save()
  }

  function setNaturalChat(on) {
    store.naturalChat = !!on
    save()
  }

  // ---------- talking to a provider
  async function request(url, init, timeoutMs) {
    let res
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      return { ok: false, ...classify(0, null, '', err) }
    }
    let text = ''
    try {
      text = await res.text()
    } catch (err) {
      return { ok: false, ...classify(0, null, '', err) }
    }
    if (!res.ok) return { ok: false, status: res.status, ...classify(res.status, res.headers, text) }
    try {
      return { ok: true, json: JSON.parse(text) }
    } catch {
      return { ok: false, kind: 'server', message: 'the provider sent something that is not JSON' }
    }
  }

  /**
   * Streamed chat completion: calls onDelta(text) for every piece as it arrives.
   * An error BEFORE the first token is a normal failure (the next key is tried); after tokens have started
   * the partial answer is kept ({ok:true, partial:true}) rather than starting over with another provider.
   */
  async function requestStream(url, init, onDelta, timeoutMs) {
    const ctl = new AbortController()
    const overall = setTimeout(() => ctl.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeoutMs)
    let firstTokenWatchdog = setTimeout(() => ctl.abort(Object.assign(new Error('no first token in time'), { name: 'TimeoutError' })), Math.min(timeoutMs, deps.firstTokenMs || FIRST_TOKEN_MS))
    const done = () => {
      clearTimeout(overall)
      clearTimeout(firstTokenWatchdog)
    }
    let res
    try {
      res = await doFetch(url, { ...init, signal: ctl.signal })
    } catch (err) {
      done()
      return { ok: false, ...classify(0, null, '', err) }
    }
    if (!res.ok) {
      let text = ''
      try {
        text = await res.text()
      } catch {
        /* ignore */
      }
      done()
      return { ok: false, status: res.status, ...classify(res.status, res.headers, text) }
    }
    // some servers ignore "stream": true and answer with one ordinary JSON body: use that
    if (/application\/json/i.test(res.headers.get('content-type') || '')) {
      try {
        const j = JSON.parse(await res.text())
        const text = extractText(j)
        const toolCalls = extractToolCalls(j)
        done()
        if (!text && !toolCalls.length) return { ok: false, kind: 'server', message: 'empty answer' }
        if (text)
          try {
            onDelta(text)
          } catch {
            /* listener bug */
          }
        return { ok: true, text, toolCalls }
      } catch (err) {
        done()
        return { ok: false, ...classify(0, null, '', err) }
      }
    }
    let full = ''
    let buf = ''
    let got = false
    const frag = new Map() // streamed tool calls arrive in pieces, keyed by index
    try {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { value, done: end } = await reader.read()
        if (end) break
        buf += dec.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          let j
          try {
            j = JSON.parse(payload)
          } catch {
            continue
          }
          for (const tc of j?.choices?.[0]?.delta?.tool_calls || []) {
            const i = Number.isInteger(tc.index) ? tc.index : 0
            const cur = frag.get(i) || { id: '', name: '', arguments: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (typeof tc.function?.arguments === 'string') cur.arguments += tc.function.arguments
            frag.set(i, cur)
            if (!got) {
              got = true
              clearTimeout(firstTokenWatchdog)
            }
          }
          const piece = j?.choices?.[0]?.delta?.content
          if (typeof piece === 'string' && piece) {
            if (!got) {
              got = true
              clearTimeout(firstTokenWatchdog)
            }
            full += piece
            try {
              onDelta(piece)
            } catch {
              /* a listener bug must not break the stream */
            }
          }
        }
      }
    } catch (err) {
      done()
      if (got) return { ok: true, text: full, partial: true, toolCalls: [] } // a half-written tool call is never run
      return { ok: false, ...classify(0, null, '', err) }
    }
    done()
    const toolCalls = [...frag.entries()].sort((a, b) => a[0] - b[0]).map(([, c], n) => ({ id: c.id || 'call_' + (n + 1), name: c.name, arguments: c.arguments || '{}' })).filter((c) => c.name)
    return full || toolCalls.length ? { ok: true, text: full, toolCalls } : { ok: false, kind: 'server', message: 'empty answer' }
  }

  /** ids of the chat models this key can see, best candidates first */
  function rankModels(ids, e) {
    const preferred = PRESETS[e.provider].models.filter((m) => ids.includes(m))
    const rest = ids.filter((i) => !preferred.includes(i) && !BAD_MODEL.test(i) && (GOOD_HINT.test(i) || e.provider === 'custom'))
    // small / fast models first: a spoken conversation needs a quick answer far more than a huge one
    rest.sort((a, c) => Number(SMALL_HINT.test(c)) - Number(SMALL_HINT.test(a)))
    const free = e.provider === 'openrouter' ? ids.filter((i) => i.endsWith(':free') && !preferred.includes(i)) : []
    const ranked = [...new Set([...preferred, ...free, ...rest])]
    // a provider whose model names we do not recognise: offer everything that is not obviously not-a-chat-model
    if (!ranked.length) ranked.push(...ids.filter((i) => !BAD_MODEL.test(i)))
    return ranked.slice(0, MAX_CANDIDATES)
  }

  /** the models to try for this key: an explicit choice, or what the provider lists (cached) */
  async function modelCandidates(e, key) {
    const s = state(e.id)
    if (e.model) return { list: [e.model] }
    if (s.cands && now() - s.candsAt < 30 * 60_000) return { list: s.model ? [s.model, ...s.cands.filter((m) => m !== s.model)] : s.cands }
    const base = e.baseUrl || PRESETS[e.provider].baseUrl
    const r = await request(`${base}/models`, { method: 'GET', headers: { Authorization: `Bearer ${key}` } }, 12_000)
    if (!r.ok) {
      if (r.kind === 'auth') return { error: r }
      return { list: s.model ? [s.model] : PRESETS[e.provider].models.slice(0, 3) } // listing failed: fall back to the presets
    }
    const ids = (r.json?.data || r.json?.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean)
    s.cands = rankModels(ids, e)
    s.candsAt = now()
    return { list: s.model ? [s.model, ...s.cands.filter((m) => m !== s.model)] : s.cands }
  }

  async function callOnline(e, messages, onDelta, tools) {
    const key = keyOf(e)
    if (!key) return { ok: false, kind: 'auth', message: 'the saved key could not be decrypted — enter it again' }
    const s = state(e.id)
    const { list, error } = await modelCandidates(e, key)
    if (error) return error
    if (!list || !list.length) return { ok: false, kind: 'model', message: 'no model selected — type one in the Model box' }
    const base = e.baseUrl || PRESETS[e.provider].baseUrl
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    if (e.provider === 'openrouter') {
      headers['X-Title'] = 'Jarvis'
      headers['HTTP-Referer'] = 'https://github.com/DhruvHarani1/jarvis'
    }
    let tried = 0
    for (const model of list) {
      if (s.badModels.has(model)) continue
      if (tried >= MAX_MODEL_TRIES) break
      tried++
      const body = { model, messages, temperature: 0.65, max_tokens: tools ? 420 : 280, stream: !!onDelta }
      if (tools) Object.assign(body, { tools, tool_choice: 'auto' })
      const init = { method: 'POST', headers, body: JSON.stringify(body) }
      const r = onDelta ? await requestStream(`${base}/chat/completions`, init, onDelta, ONLINE_STREAM_MS) : await request(`${base}/chat/completions`, init, ONLINE_TIMEOUT_MS)
      if (r.ok) {
        const text = (r.text !== undefined ? r.text : extractText(r.json)).trim()
        const toolCalls = r.toolCalls !== undefined ? r.toolCalls : extractToolCalls(r.json)
        if (!text && !toolCalls.length) return { ok: false, kind: 'server', message: 'empty answer' }
        s.model = model
        return { ok: true, text, toolCalls, model }
      }
      if (r.kind === 'model') {
        // "not found for this account" and friends: that model is not switched on for this key, try the next one
        s.badModels.add(model)
        if (s.model === model) s.model = ''
        continue
      }
      return r
    }
    return {
      ok: false,
      kind: 'model',
      message: tried
        ? `none of the ${tried} models I tried are available to this key — type a model name from the provider's catalog into the Model box`
        : 'no usable model for this key'
    }
  }

  async function callLocal(messages, onDelta, tools) {
    if (!deps.ollama) return { ok: false, kind: 'network', message: 'local model unavailable' }
    const st = await deps.ollama.status().catch(() => ({ available: false }))
    if (!st.available) return { ok: false, kind: 'network', message: 'Ollama is not running or has no model' }
    const lbody = { model: st.model, messages, temperature: 0.65, max_tokens: tools ? 420 : 220, stream: !!onDelta }
    if (tools) Object.assign(lbody, { tools })
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lbody) }
    const r = onDelta ? await requestStream(`${OLLAMA_BASE}/chat/completions`, init, onDelta, LOCAL_TIMEOUT_MS) : await request(`${OLLAMA_BASE}/chat/completions`, init, LOCAL_TIMEOUT_MS)
    if (!r.ok) return r
    const text = (r.text !== undefined ? r.text : extractText(r.json)).trim()
    const toolCalls = r.toolCalls !== undefined ? r.toolCalls : extractToolCalls(r.json)
    return text || toolCalls.length ? { ok: true, text, toolCalls, model: st.model } : { ok: false, kind: 'server', message: 'empty answer' }
  }

  function penalise(e, r) {
    const s = state(e.id)
    s.fails++
    s.lastError = r.message
    const backoff = (base, cap) => Math.min(cap, base * 2 ** Math.min(s.fails - 1, 6))
    if (r.kind === 'auth') s.bad = true
    else if (r.kind === 'rate') s.until = now() + (r.retryAfterMs !== undefined ? Math.min(r.retryAfterMs, 3600_000) : backoff(60_000, 15 * 60_000))
    else if (r.kind === 'model') {
      s.until = now() + 5 * 60_000
      s.model = '' // look the model list up again next time
    } else s.until = now() + backoff(20_000, 5 * 60_000)
  }

  /**
   * Ask the chain. Up to three online keys are tried in order, then the local model.
   * @param {{role:string,content:string}[]} messages
   * @returns {Promise<{ok:boolean, text?:string, via?:string, chain:string[], error?:string}>}
   */
  async function chat(messages, onDelta, opts = {}) {
    const tools = opts.tools && opts.tools.length ? opts.tools : undefined
    const chain = []
    const usable = store.entries.filter((e) => e.enabled !== false && !state(e.id).bad && state(e.id).until <= now())
    let tries = 0
    for (const e of usable) {
      if (tries >= MAX_ONLINE_TRIES) break
      tries++
      const r = await callOnline(e, messages, onDelta, tools)
      if (r.ok) {
        const s = state(e.id)
        Object.assign(s, { fails: 0, until: 0, bad: false, lastError: '', lastOk: now() })
        chain.push(`${e.label}: ok`)
        lastChain = chain
        return { ok: true, text: r.text, toolCalls: r.toolCalls || [], via: `${e.label} (${r.model})`, chain }
      }
      penalise(e, r)
      chain.push(`${e.label}: ${r.message}`)
    }
    const local = await callLocal(messages, onDelta, tools)
    if (local.ok) {
      chain.push('local Ollama: ok')
      lastChain = chain
      return { ok: true, text: local.text, toolCalls: local.toolCalls || [], via: `local Ollama (${local.model})`, chain }
    }
    chain.push(`local Ollama: ${local.message}`)
    lastChain = chain
    return { ok: false, chain, error: store.entries.length ? 'every key failed and the local model is not available' : 'no AI keys set up and no local model found' }
  }

  /**
   * Speech to text through a Groq key (Whisper): same failover rules as chat.
   * @param {Uint8Array|Buffer} wav 16 kHz mono 16-bit WAV
   * @returns {Promise<{ok:boolean, text?:string, via?:string, chain:string[], error?:string}>}
   */
  async function transcribe(wav) {
    const chain = []
    const usable = store.entries.filter((e) => e.provider === 'groq' && e.enabled !== false && !state(e.id).bad && state(e.id).until <= now())
    let tries = 0
    for (const e of usable) {
      if (tries >= MAX_ONLINE_TRIES) break
      tries++
      const key = keyOf(e)
      if (!key) {
        chain.push(`${e.label}: key unreadable`)
        continue
      }
      const base = e.baseUrl || PRESETS.groq.baseUrl
      let r
      for (const model of STT_MODELS) {
        const form = new FormData()
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
        form.append('model', model)
        form.append('response_format', 'json')
        form.append('temperature', '0')
        form.append('prompt', STT_PROMPT)
        r = await request(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }, 30_000)
        if (r.ok || r.kind !== 'model') break // only a "no such model" error moves on to the next Whisper model
      }
      if (r.ok) {
        const text = String(r.json?.text ?? '').replace(/\s+/g, ' ').trim()
        const s = state(e.id)
        Object.assign(s, { fails: 0, until: 0, bad: false, lastError: '', lastOk: now() })
        chain.push(`${e.label}: ok`)
        return { ok: true, text, via: e.label, chain }
      }
      penalise(e, r)
      chain.push(`${e.label}: ${r.message}`)
    }
    return { ok: false, chain, error: usable.length ? 'every Groq key failed' : 'no Groq key set up' }
  }

  /** is there a Groq key that could transcribe right now? */
  const canTranscribe = () => store.entries.some((e) => e.provider === 'groq' && e.enabled !== false && !state(e.id).bad && state(e.id).until <= now())

  /** "Test" button: one tiny question, updates the key's status */
  async function test(id) {
    const e = find(id)
    if (!e) return { ok: false, error: 'no such key' }
    const s = state(e.id)
    s.bad = false
    s.until = 0
    Object.assign(s, { model: '', cands: null, badModels: new Set() })
    const t0 = now()
    const r = await callOnline(e, [{ role: 'user', content: 'Reply with the single word: ready' }])
    if (r.ok) {
      Object.assign(s, { fails: 0, lastError: '', lastOk: now(), model: e.model ? s.model : r.model })
      return { ok: true, ms: now() - t0, model: r.model }
    }
    penalise(e, r)
    return { ok: false, error: r.message, kind: r.kind }
  }

  /** is there anything that could answer a chat right now? (used to decide whether Jarvis should chat naturally) */
  async function ready() {
    if (!store.naturalChat) return false
    if (store.entries.some((e) => e.enabled !== false && !state(e.id).bad)) return true
    if (deps.ollama) return !!(await deps.ollama.status().catch(() => ({ available: false }))).available
    return false
  }

  return { list, getSettings, add, update, remove, move, setNaturalChat, chat, transcribe, canTranscribe, test, ready, lastChain: () => lastChain, _state: state }
}

module.exports = { createBrain, PRESETS, classify, extractText, cleanBaseUrl, cleanKey, MAX_ONLINE_TRIES, OLLAMA_BASE }
