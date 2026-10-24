'use strict'
/**
 * The tool runtime: the ONE place where anything Jarvis can do gets checked, confirmed, run, logged and made undoable.
 * Whatever asks (the language model, a fast-path voice command, a button), the same rules apply.
 *
 *   tiers   T0 read only | T1 reversible local change | T2 consequential (always asks) | T3 power mode only (always asks, full command shown)
 *   taint   once untrusted text (a message, a web page, a file) has entered the conversation, T2/T3 need a CLICK on screen
 *
 * The model can only call tools that are registered here, with arguments that pass the tool's schema. Nothing is ever run from a string.
 */
const { validate } = require('./schema')

const TIERS = ['T0', 'T1', 'T2', 'T3']
const UNDO_DEPTH = 20

/**
 * @param {{audit:{log:(e:any)=>void}, confirm:(req:{tool:string, tier:string, title:string, detail:string, requireClick:boolean})=>Promise<boolean>,
 *          powerMode?:()=>boolean, disabled?:()=>string[], now?:()=>number}} deps
 */
function createRuntime({ audit, confirm, powerMode = () => false, disabled = () => [], now = Date.now }) {
  /** @type {Map<string, any>} */
  const tools = new Map()
  const undoStack = []
  let nextUndo = 1

  function register(tool) {
    if (!tool || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(tool.name)) throw new Error('bad tool name')
    if (!TIERS.includes(tool.tier)) throw new Error(`tool ${tool.name}: bad tier`)
    if (!tool.schema || tool.schema.type !== 'object') throw new Error(`tool ${tool.name}: schema must be an object`)
    if (typeof tool.run !== 'function') throw new Error(`tool ${tool.name}: no run()`)
    if (tools.has(tool.name)) throw new Error(`tool ${tool.name} is already registered`)
    tools.set(tool.name, { describe: (a) => JSON.stringify(a), ...tool })
  }

  const available = (t) => !disabled().includes(t.name) && (t.tier !== 'T3' || powerMode()) && (!t.enabled || t.enabled()) // enabled(): a tool that needs a connected account hides itself until there is one

  /** the list handed to the language model (OpenAI function-calling format); a tool the user switched off is not even shown */
  function specs() {
    return [...tools.values()]
      .filter(available)
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.schema } }))
  }

  /**
   * Run a tool call.
   * @param {string} name
   * @param {any} rawArgs object, or the JSON text a model produced
   * @param {{source?:string, tainted?:boolean}} ctx
   * @returns {Promise<{ok:boolean, spoken?:string, data?:any, untrusted?:boolean, error?:string, denied?:boolean, declined?:boolean, undoId?:number}>}
   */
  async function call(name, rawArgs, ctx = {}) {
    const source = ctx.source || 'agent'
    const tool = tools.get(name)
    const entry = { tool: name, tier: tool && tool.tier, source, args: rawArgs }
    const refuse = (error, extra = {}) => {
      audit.log({ ...entry, decision: extra.declined ? 'declined' : 'denied', ok: false, error })
      return { ok: false, error, ...extra }
    }
    if (!tool) return refuse('there is no such tool', { denied: true })
    if (!available(tool)) return refuse(tool.tier === 'T3' ? 'power mode is off' : 'this tool is switched off', { denied: true })

    let args = rawArgs
    if (typeof args === 'string') {
      try {
        args = args.trim() ? JSON.parse(args) : {}
      } catch {
        return refuse('the arguments were not valid JSON', { denied: true })
      }
    }
    const v = validate(tool.schema, args === undefined ? {} : args)
    if (!v.ok) return refuse(v.error, { denied: true })
    entry.args = v.value

    let decision = 'allow'
    if (tool.tier === 'T2' || tool.tier === 'T3') {
      const tainted = !!ctx.tainted
      let yes = false
      try {
        yes = await confirm({
          tool: name,
          tier: tool.tier,
          title: tool.title || name.replace(/_/g, ' '),
          detail: tool.describe(v.value),
          requireClick: tainted || tool.tier === 'T3'
        })
      } catch {
        yes = false
      }
      if (!yes) return refuse('you said no', { declined: true })
      decision = 'confirmed'
    }

    let result
    try {
      result = await tool.run(v.value, { source, tainted: !!ctx.tainted })
    } catch (e) {
      const error = String((e && e.message) || e)
      audit.log({ ...entry, decision, ok: false, error })
      return { ok: false, error }
    }
    const out = { ok: true, spoken: result && result.spoken, data: result && result.data, untrusted: !!(result && result.untrusted) } // untrusted: the result contains text a stranger could have written
    let undoId
    if (result && typeof result.undo === 'function') {
      undoId = nextUndo++
      undoStack.push({ id: undoId, tool: name, label: result.undoLabel || name, fn: result.undo })
      while (undoStack.length > UNDO_DEPTH) undoStack.shift()
      out.undoId = undoId
    }
    audit.log({ ...entry, decision, ok: true, result: { spoken: out.spoken, data: out.data }, undoId })
    return out
  }

  /** undo the most recent undoable action */
  async function undo() {
    const u = undoStack.pop()
    if (!u) return { ok: false, error: 'there is nothing to undo' }
    try {
      const r = await u.fn()
      audit.log({ tool: 'undo', tier: 'T1', source: 'user', args: { of: u.tool, id: u.id }, decision: 'allow', ok: true, result: { spoken: r && r.spoken } })
      return { ok: true, spoken: (r && r.spoken) || `Undone: ${u.label}.` }
    } catch (e) {
      const error = String((e && e.message) || e)
      audit.log({ tool: 'undo', tier: 'T1', source: 'user', args: { of: u.tool, id: u.id }, decision: 'allow', ok: false, error })
      return { ok: false, error }
    }
  }

  return {
    register,
    specs,
    call,
    undo,
    has: (n) => tools.has(n),
    isAvailable: (n) => tools.has(n) && available(tools.get(n)),
    get: (n) => tools.get(n),
    names: () => [...tools.keys()],
    tiers: () => [...tools.values()].map((t) => ({ name: t.name, tier: t.tier })),
    undoLabel: () => (undoStack.length ? undoStack[undoStack.length - 1].label : null),
    now
  }
}

module.exports = { createRuntime, TIERS, UNDO_DEPTH }
