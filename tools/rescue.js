'use strict'
/**
 * Some models write a tool call as TEXT in their own dialect instead of using the structured tool_calls field. This turns the
 * known dialects back into real calls so the turn does not end with gibberish being read aloud. Only tools that were actually
 * offered are accepted; anything else stays plain text. (The idea comes from FreeLLMAPI's tool-call-rescue, MIT, rewritten here.)
 *
 *   1. <tool_call>{"name": "...", "arguments": {...}}</tool_call>                          (Qwen / Hermes)
 *   2. <function=NAME>{...}</function>   and   <function=NAME{...}</function>             (Llama)
 *   3. <|tool_call_begin|>functions.NAME:0<|tool_call_argument_begin|>{...}<|tool_call_end|>   (Kimi / DeepSeek)
 *   4. a lone {"name": KNOWN, "arguments": {...}} object, bare or in a ```json fence      (only when the name is a known tool)
 */

function parseJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** @param {string} text @param {Set<string>|string[]} names @returns {{calls:{id:string,name:string,arguments:string}[], text:string, dead:boolean}} */
function rescue(text, names) {
  const known = names instanceof Set ? names : new Set(names)
  const calls = []
  let rest = String(text || '')
  let sawDialect = false
  const add = (name, args) => {
    if (!known.has(name)) return false
    const a = typeof args === 'string' ? args : JSON.stringify(args === undefined ? {} : args)
    calls.push({ id: `call_rescued_${calls.length + 1}`, name, arguments: a })
    return true
  }

  // 1. <tool_call>{json}</tool_call>
  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (m, body) => {
    sawDialect = true
    const j = parseJson(body)
    return j && typeof j.name === 'string' && add(j.name, j.arguments ?? j.parameters ?? {}) ? '' : m
  })
  // 2. <function=NAME>{json}</function>
  rest = rest.replace(/<function=([a-z][a-z0-9_]*)>?\s*(\{[\s\S]*?\})?\s*<\/function>/g, (m, name, body) => {
    sawDialect = true
    const j = body ? parseJson(body) : {}
    return j !== undefined && add(name, j) ? '' : m
  })
  // 3. token style
  rest = rest.replace(/<\|tool_calls_section_begin\|>|<\|tool_calls_section_end\|>/g, () => ((sawDialect = true), ''))
  rest = rest.replace(/<\|tool_call_begin\|>\s*(?:functions\.)?([a-z][a-z0-9_]*)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g, (m, name, body) => {
    sawDialect = true
    const j = parseJson(body)
    return j !== undefined && add(name, j) ? '' : m
  })
  // 4. bare / fenced object, only when it is the whole answer and names a known tool
  if (!calls.length) {
    const t = rest.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    if (t.startsWith('{') && t.endsWith('}')) {
      const j = parseJson(t)
      if (j && typeof j.name === 'string' && add(j.name, j.arguments ?? j.parameters ?? {})) rest = ''
    }
  }
  // a dialect was present but nothing usable came out of it: the turn is dead, do not read the markup aloud
  const leftover = /<tool_call>|<function=|<\|tool_call/.test(rest)
  return { calls, text: rest.trim(), dead: sawDialect && !calls.length && leftover }
}

module.exports = { rescue }
