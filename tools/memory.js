'use strict'
/**
 * Memory tools: remember, recall, forget, forget everything. Everything stays in the local database (memory/store.js).
 *
 * A fact stored while untrusted text was in the conversation is marked "tainted": it is kept (the user may have wanted it) but
 * never put into a prompt by itself, and it is labelled when shown, so a hostile email cannot plant a standing instruction.
 */
const obj = (properties, required = []) => ({ type: 'object', properties, required })
const THAT = /^(that|it|this|the last one|the last thing|what i just said)$/i

/** @param {{memory:ReturnType<typeof import('../memory/store').create>}} d */
function createMemoryTools(d) {
  const m = d.memory
  const T = []

  T.push({
    name: 'remember',
    tier: 'T1',
    description: 'Remember a short fact about the user or their life, in one sentence ("My sister is called Asha"). Use only when the user asks you to remember something or clearly shares something to keep. Never store passwords, keys or card numbers.',
    schema: obj({ text: { type: 'string', minLength: 3, maxLength: 300 }, tags: { type: 'string', maxLength: 80 } }, ['text']),
    run: async ({ text, tags }, ctx = {}) => {
      const source = ctx.tainted ? 'tainted' : ctx.source === 'fastpath' ? 'user' : 'model'
      const r = m.remember({ text, tags, source })
      if (!r.ok) throw new Error(r.error)
      if (r.duplicate) return { spoken: 'I already knew that.' }
      return {
        spoken: ctx.tainted ? 'Noted, but I will only use it when you ask me about it.' : 'I will remember that.',
        data: { id: r.fact.id },
        undoLabel: 'remembering that',
        undo: async () => (m.forget(r.fact.id), { spoken: 'Forgotten again.' })
      }
    }
  })

  T.push({
    name: 'recall',
    tier: 'T0',
    description: 'Look up what you remember about something. With an empty query, list the most recent things you remember.',
    schema: obj({ query: { type: 'string', maxLength: 120 } }),
    run: async ({ query = '' }) => {
      const found = query.trim() ? m.search(query, { limit: 5 }) : m.list(5)
      if (!found.length) return { spoken: query.trim() ? 'I do not remember anything about that.' : 'I do not remember anything yet.', data: [] }
      const total = m.count()
      const says = found.map((f) => (f.source === 'tainted' ? `${f.text} (stored while I was reading something untrusted)` : f.text))
      return { spoken: (query.trim() ? '' : `I remember ${total} thing${total === 1 ? '' : 's'}. `) + says.join('. ') + '.', data: found, untrusted: found.some((f) => f.source === 'tainted') }
    }
  })

  T.push({
    name: 'forget',
    tier: 'T1',
    description: 'Forget one remembered fact: the one that best matches the query, or the latest one when the query is "that".',
    schema: obj({ query: { type: 'string', minLength: 1, maxLength: 120 } }, ['query']),
    run: async ({ query }) => {
      const hit = THAT.test(query.trim()) ? m.list(1)[0] : m.search(query, { limit: 1, touch: false })[0]
      if (!hit) return { spoken: 'I do not remember anything like that.' }
      const gone = m.forget(hit.id)
      return {
        spoken: `Forgotten: ${gone.text}.`,
        data: { text: gone.text },
        undoLabel: 'forgetting that',
        undo: async () => (m.restore(gone), { spoken: 'Remembered again.' })
      }
    }
  })

  T.push({
    name: 'forget_everything',
    tier: 'T2',
    title: 'Erase all memory',
    description: 'Erase everything remembered and the saved conversation. Only when the user clearly asks to wipe your memory.',
    schema: obj({}),
    describe: () => `Erase everything I remember (${m.count()} fact${m.count() === 1 ? '' : 's'}) and the saved conversation.\n\nThis cannot be undone.`,
    run: async () => {
      const n = m.forgetAll()
      return { spoken: n ? `Done. I forgot all ${n} thing${n === 1 ? '' : 's'}.` : 'There was nothing to forget.' }
    }
  })

  return T
}

module.exports = { createMemoryTools }
