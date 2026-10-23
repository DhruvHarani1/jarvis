'use strict'
/**
 * Optional free-form brain for Jarvis: a small open-source model running locally through Ollama.
 * Nothing leaves the machine (127.0.0.1 only). No Ollama installed => Jarvis just uses its rule engine.
 */
const BASE = 'http://127.0.0.1:11434'
const PREFER = [/qwen2\.5.*(0\.5|1\.5|3)b/i, /llama3\.2/i, /smollm/i, /gemma/i, /phi/i, /qwen/i]

async function listModels() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return []
    const j = await res.json()
    return (j.models || []).map((m) => m.name).filter(Boolean)
  } catch {
    return []
  }
}

function pickModel(models, wanted) {
  if (wanted && models.includes(wanted)) return wanted
  for (const re of PREFER) {
    const m = models.find((n) => re.test(n))
    if (m) return m
  }
  return models[0] || ''
}

async function status(wanted) {
  const models = await listModels()
  const model = pickModel(models, wanted)
  return { available: !!model, model }
}

const SYSTEM =
  'You are Jarvis, a terse, witty voice assistant on the user’s Windows PC. Be friendly, witty, max 25 words. ' +
  'Reply ONLY with JSON: {"say":"...","action":null}. action may be one of ' +
  '{"type":"remind","minutes":N,"text":"..."} | {"type":"timer","op":"focus|break|pause|reset"} | {"type":"sound","on":true|false} | {"type":"collapse"}. ' +
  'Use an action only if the user clearly asks for it. Never invent PC numbers: use the live stats given.'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** Turn whatever the model returned into a safe {say, action} for the renderer. */
function sanitize(content) {
  let obj = null
  try {
    obj = JSON.parse(content)
  } catch {
    const m = /\{[\s\S]*\}/.exec(content || '')
    if (m) {
      try {
        obj = JSON.parse(m[0])
      } catch {
        obj = null
      }
    }
  }
  if (!obj || typeof obj !== 'object') return { say: String(content || '').slice(0, 220) || null, action: null }
  const say = typeof obj.say === 'string' ? obj.say.slice(0, 220) : null
  let action = null
  const a = obj.action
  if (a && typeof a === 'object') {
    if (a.type === 'remind' && Number.isFinite(Number(a.minutes)) && typeof a.text === 'string') {
      const minutes = clamp(Math.round(Number(a.minutes)), 1, 1440)
      action = { type: 'remind', raw: `in ${minutes}m ${a.text.slice(0, 60)}` }
    } else if (a.type === 'timer' && ['focus', 'break', 'pause', 'reset'].includes(a.op)) action = { type: 'timer', op: a.op }
    else if (a.type === 'sound' && typeof a.on === 'boolean') action = { type: 'sound', on: a.on }
    else if (a.type === 'collapse') action = { type: 'collapse' }
  }
  return { say, action }
}

function brief(ctx) {
  const s = (ctx && ctx.stats) || {}
  const parts = []
  if (Number.isFinite(s.cpu)) parts.push(`cpu ${Math.round(s.cpu)}%`)
  if (Number.isFinite(s.ram)) parts.push(`ram ${Math.round(s.ram)}%`)
  if (Number.isFinite(s.disk)) parts.push(`disk ${Math.round(s.disk)}%`)
  if (s.hog && typeof s.hog.name === 'string') parts.push(`biggest process ${s.hog.name.slice(0, 40)} ${Number(s.hog.mb) || 0}MB`)
  if (s.online === false) parts.push('offline')
  else if (Number.isFinite(s.latencyMs)) parts.push(`ping ${Math.round(s.latencyMs)}ms`)
  const b = ctx && ctx.battery
  if (b && b.present) parts.push(`battery ${Math.round(b.level * 100)}%${b.charging ? ' charging' : ''}`)
  return parts.join(', ')
}

async function ask(text, ctx, wantedModel) {
  const { model } = await status(wantedModel)
  if (!model) return null
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        keep_alive: '5m',
        options: { temperature: 0.3, num_predict: 140 },
        messages: [
          { role: 'system', content: `${SYSTEM} Live stats: ${brief(ctx) || 'unknown'}.` },
          { role: 'user', content: String(text).slice(0, 300) }
        ]
      })
    })
    if (!res.ok) return null
    const j = await res.json()
    return sanitize(j.message && j.message.content)
  } catch {
    return null
  }
}

module.exports = { status, ask, sanitize, pickModel, brief }
