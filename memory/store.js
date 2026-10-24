'use strict'
/**
 * Jarvis's memory: facts the user asked him to remember, and the recent conversation, in a local SQLite file
 * (node:sqlite, built into Node 24 and therefore into Electron 44). Nothing leaves the PC from here.
 *
 *   facts      one short sentence each, found again by keyword (SQLite FTS5, English stemming), never embeddings
 *   messages   the last turns of the conversation, so a restart does not make him forget what you were just saying
 *   source     'user' (said directly), 'model' (the assistant chose to store it), 'tainted' (stored while untrusted text was in the
 *              conversation): tainted facts are never put into a prompt on their own, only shown when asked for
 */
const fs = require('node:fs')
const path = require('node:path')
const { looksSecret } = require('./secrets')

const MAX_FACTS = 500
const MAX_FACT_CHARS = 300
const HISTORY_KEEP = 60
const STOP = new Set('a an the my me i is are was were be been to of and or in on at for with that this it its do does did you your about what who which when where how'.split(' '))

const MIGRATIONS = [
  `CREATE TABLE facts (id INTEGER PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, uses INTEGER NOT NULL DEFAULT 0);
   CREATE VIRTUAL TABLE facts_fts USING fts5(text, tags, content='facts', content_rowid='id', tokenize='porter unicode61');
   CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags); END;
   CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN INSERT INTO facts_fts(facts_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags); END;
   CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN INSERT INTO facts_fts(facts_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags); INSERT INTO facts_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags); END;
   CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL);`
]

/** words worth searching for: letters and digits, no filler words */
function terms(q) {
  return [...new Set(String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].filter((w) => w.length > 1 && !STOP.has(w)).slice(0, 8)
}
const ftsQuery = (q) => terms(q).map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ')

/** @param {{file:string, DatabaseSync?:any, now?:()=>number}} o */
function create({ file, DatabaseSync, now = Date.now }) {
  const DB = DatabaseSync || require('node:sqlite').DatabaseSync
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DB(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)')
  let v = db.prepare('SELECT max(v) AS v FROM schema_version').get().v || 0
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i])
      db.prepare('INSERT INTO schema_version (v) VALUES (?)').run(i + 1)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  const q = {
    insert: db.prepare('INSERT INTO facts (text, tags, source, created) VALUES (?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM facts WHERE id = ?'),
    byText: db.prepare('SELECT * FROM facts WHERE lower(text) = lower(?)'),
    del: db.prepare('DELETE FROM facts WHERE id = ?'),
    count: db.prepare('SELECT count(*) AS n FROM facts'),
    all: db.prepare('SELECT * FROM facts ORDER BY created DESC, id DESC LIMIT ?'),
    top: db.prepare("SELECT * FROM facts WHERE source != 'tainted' ORDER BY uses DESC, created DESC LIMIT ?"),
    touch: db.prepare('UPDATE facts SET uses = uses + 1, last_used = ? WHERE id = ?'),
    search: db.prepare("SELECT f.*, bm25(facts_fts) AS rank FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?"),
    addMsg: db.prepare('INSERT INTO messages (role, content, ts) VALUES (?, ?, ?)'),
    trimMsgs: db.prepare('DELETE FROM messages WHERE id <= (SELECT max(id) FROM messages) - ?'),
    recent: db.prepare('SELECT role, content, ts FROM messages WHERE ts >= ? ORDER BY id DESC LIMIT ?'),
    clearFacts: db.prepare('DELETE FROM facts'),
    clearMsgs: db.prepare('DELETE FROM messages')
  }

  const pub = (f) => ({ id: f.id, text: f.text, tags: f.tags, source: f.source, created: f.created, uses: f.uses })

  /**
   * @param {{text:string, tags?:string, source?:'user'|'model'|'tainted'}} f
   * @returns {{ok:true, fact:any, duplicate:boolean}|{ok:false, error:string}}
   */
  function remember({ text, tags = '', source = 'user' }) {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (t.length < 3) return { ok: false, error: 'there is nothing to remember in that' }
    if (t.length > MAX_FACT_CHARS) return { ok: false, error: `that is too long to remember (max ${MAX_FACT_CHARS} characters); say it shorter` }
    const secret = looksSecret(t) || looksSecret(tags)
    if (secret) return { ok: false, error: `that looks like ${secret}, and I never keep those` }
    const same = q.byText.get(t)
    if (same) return { ok: true, fact: pub(same), duplicate: true }
    if (q.count.get().n >= MAX_FACTS) return { ok: false, error: 'my memory is full; forget something first' }
    const r = q.insert.run(t, String(tags).slice(0, 80), source, now())
    return { ok: true, fact: pub(q.byId.get(Number(r.lastInsertRowid))), duplicate: false }
  }

  /** best matches for a question, most relevant first; marks them as used */
  function search(query, { limit = 5, includeTainted = true, touch = true } = {}) {
    const m = ftsQuery(query)
    if (!m) return []
    let rows = []
    try {
      rows = q.search.all(m, limit * 2)
    } catch {
      return []
    }
    rows = rows.filter((r) => includeTainted || r.source !== 'tainted').slice(0, limit)
    if (touch) for (const r of rows) q.touch.run(now(), r.id)
    return rows.map(pub)
  }

  const list = (limit = 50) => q.all.all(limit).map(pub)
  const get = (id) => {
    const f = q.byId.get(id)
    return f ? pub(f) : null
  }
  function forget(id) {
    const f = q.byId.get(id)
    if (!f) return null
    q.del.run(id)
    return pub(f)
  }
  /** put a forgotten fact back (undo) */
  function restore(f) {
    return remember({ text: f.text, tags: f.tags, source: f.source })
  }
  const count = () => q.count.get().n

  /** the few facts worth giving the model with this question: matches first, then the most used. Never tainted ones. */
  function forPrompt(userText, { max = 6, maxChars = 600 } = {}) {
    const picked = []
    const seen = new Set()
    for (const f of [...search(userText, { limit: max, includeTainted: false }), ...q.top.all(max).map(pub)]) {
      if (seen.has(f.id) || picked.length >= max) continue
      seen.add(f.id)
      picked.push(f)
    }
    const out = []
    let used = 0
    for (const f of picked) {
      if (used + f.text.length > maxChars) break
      out.push(f.text)
      used += f.text.length
    }
    return out
  }

  // ---- conversation
  function addMessage(role, content) {
    q.addMsg.run(role === 'assistant' ? 'assistant' : 'user', String(content).slice(0, 800), now())
    q.trimMsgs.run(HISTORY_KEEP)
  }
  /** the recent turns, oldest first; nothing older than maxAgeMs (so yesterday's chat is not dragged along) */
  function recentMessages({ limit = 24, maxAgeMs = 12 * 3600_000 } = {}) {
    return q.recent.all(now() - maxAgeMs, limit).reverse().map((r) => ({ role: r.role, content: r.content }))
  }
  const clearMessages = () => q.clearMsgs.run()

  /** everything, for the export and for "forget everything" */
  function exportAll() {
    return { exportedAt: new Date(now()).toISOString(), facts: q.all.all(MAX_FACTS).map(pub), messages: db.prepare('SELECT role, content, ts FROM messages ORDER BY id').all() }
  }
  function forgetAll() {
    const n = q.count.get().n
    q.clearFacts.run()
    q.clearMsgs.run()
    db.exec("INSERT INTO facts_fts(facts_fts) VALUES ('rebuild')")
    return n
  }
  const close = () => db.close()

  return { remember, search, list, get, forget, restore, count, forPrompt, addMessage, recentMessages, clearMessages, exportAll, forgetAll, close, terms, MAX_FACTS }
}

module.exports = { create, terms, ftsQuery, MAX_FACTS, MAX_FACT_CHARS }
