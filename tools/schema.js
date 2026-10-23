'use strict'
/**
 * A small JSON-schema checker for tool arguments (only what tools need): object with typed properties, required,
 * enum, string length / pattern, number range, no unknown properties. Arguments come from a language model, so they are
 * treated as hostile: anything not described by the schema is refused, never silently passed on.
 */

/**
 * @param {any} schema
 * @param {any} value
 * @returns {{ok:true, value:any}|{ok:false, error:string}}
 */
function validate(schema, value, path = 'arguments') {
  const t = schema.type
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad(path, 'must be an object')
    const props = schema.properties || {}
    const out = {}
    for (const k of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) return bad(`${path}.${k}`, 'is not an allowed argument')
    }
    for (const k of schema.required || []) {
      if (value[k] === undefined) return bad(`${path}.${k}`, 'is required')
    }
    for (const k of Object.keys(props)) {
      if (value[k] === undefined) continue
      const r = validate(props[k], value[k], `${path}.${k}`)
      if (!r.ok) return r
      out[k] = r.value
    }
    return { ok: true, value: out }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return bad(path, `must be one of ${schema.enum.join(', ')}`)
  if (t === 'string') {
    if (typeof value !== 'string') return bad(path, 'must be text')
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return bad(path, `is too long (max ${schema.maxLength})`)
    if (schema.minLength !== undefined && value.length < schema.minLength) return bad(path, 'is too short')
    if (value.includes('\0')) return bad(path, 'contains an invalid character')
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return bad(path, 'has the wrong format')
    return { ok: true, value }
  }
  if (t === 'integer' || t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return bad(path, 'must be a number')
    if (t === 'integer' && !Number.isInteger(value)) return bad(path, 'must be a whole number')
    if (schema.minimum !== undefined && value < schema.minimum) return bad(path, `must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) return bad(path, `must be at most ${schema.maximum}`)
    return { ok: true, value }
  }
  if (t === 'boolean') return typeof value === 'boolean' ? { ok: true, value } : bad(path, 'must be true or false')
  return bad(path, 'has an unsupported type in the tool definition')
}

const bad = (path, msg) => ({ ok: false, error: `${path} ${msg}` })

module.exports = { validate }
