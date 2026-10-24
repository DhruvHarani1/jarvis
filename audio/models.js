'use strict'
/**
 * Voice models: what they are, where they live, and how they are downloaded.
 *
 * Nothing is bundled in the installer (they are 20-110 MB each). The user is asked first (name, source, size); each file is
 * checked against a pinned SHA-256 (npm tarballs: SHA-512 integrity) before it is unpacked, and unpacked with Windows' own
 * tar.exe into a fresh folder, so a bad archive can never write outside it.
 *
 * Look-up order for an installed item: $JARVIS_MODELS_DIR, <userData>/models, <repo>/models-dev (developer checkout).
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const SHERPA = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

/** @type {Record<string, {title:string, why:string, kind:'tar.bz2'|'npm', url:string, sha256?:string, integrity?:string, bytes:number, dir:string, license:string, optional?:boolean}>} */
const MANIFEST = {
  stt: {
    title: 'Speech recognition (Moonshine base, English)',
    why: 'understands what you say, on this PC',
    kind: 'tar.bz2',
    url: `${SHERPA}/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`,
    sha256: '43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891',
    bytes: 111266225,
    dir: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27',
    license: 'MIT'
  },
  voice: {
    title: 'Voice (Piper "Alan", British English)',
    why: 'a natural voice for Jarvis, faster than real time on this PC',
    kind: 'tar.bz2',
    url: `${SHERPA}/tts-models/vits-piper-en_GB-alan-medium-int8.tar.bz2`,
    sha256: 'f0b2526c9600657141ccbbe412f6159dceedab5bab4ba4e8857d9443acb50de4',
    bytes: 21103831,
    dir: 'vits-piper-en_GB-alan-medium-int8',
    license: 'see MODEL_CARD inside the voice folder (Piper voice dataset licence)'
  },
  wake: {
    title: 'Wake word ("Hey Jarvis")',
    why: 'listens for the wake phrase only, on this PC',
    kind: 'tar.bz2',
    url: `${SHERPA}/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`,
    sha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a',
    bytes: 17626723,
    dir: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
    license: 'Apache-2.0'
  },
  phonemizer: {
    title: 'Phonemizer for Piper voices (piper-phonemize-node, GPL-3.0-or-later)',
    why: 'turns text into sounds for the Piper voice; downloaded separately and not linked into Jarvis',
    kind: 'npm',
    url: 'https://registry.npmjs.org/piper-phonemize-node/-/piper-phonemize-node-1.5.9.tgz',
    integrity: 'sha512-IpGK1jqf3LwB47lHSjvu9jz8n9ayVGNc9OnC/gMcIH5gHS+q7Mxw46158bj36mtd4QRKMsF8f5mSEPdtoSP56w==',
    bytes: 3000000,
    dir: 'piper-phonemize/node_modules/piper-phonemize-node',
    license: 'GPL-3.0-or-later'
  },
  'phonemizer-win-x64': {
    title: 'Phonemizer native part (Windows x64)',
    why: 'part of the phonemizer above',
    kind: 'npm',
    url: 'https://registry.npmjs.org/piper-phonemize-win-x64/-/piper-phonemize-win-x64-1.5.9.tgz',
    integrity: 'sha512-ld6F+SsxPJuzkF+pWKz/NiL/7KRNH3yCAv5CcDQTsvdGGfb9tNexPxsz3jCM1iRqHlCcFcW3CZhDSC5huANHHw==',
    bytes: 1200000,
    dir: 'piper-phonemize/node_modules/piper-phonemize-win-x64',
    license: 'GPL-3.0-or-later'
  }
}

/** items that must exist together for a feature */
const BUNDLES = {
  stt: ['stt'],
  voice: ['voice', 'phonemizer', 'phonemizer-win-x64'],
  wake: ['wake']
}

let userRoot = null
/** call once from main with app.getPath('userData') */
function setUserDir(dir) {
  userRoot = dir ? path.join(dir, 'models') : null
}

function roots() {
  const list = []
  if (process.env.JARVIS_MODELS_DIR) list.push(process.env.JARVIS_MODELS_DIR)
  if (userRoot) list.push(userRoot)
  list.push(path.join(__dirname, '..', 'models-dev'))
  return list
}

/** folder of an installed item, or null */
function locate(id) {
  const m = MANIFEST[id]
  if (!m) return null
  for (const r of roots()) {
    const p = path.join(r, m.dir)
    if (fs.existsSync(p)) return p
  }
  // developer layout: the phonemizer was installed with npm into <models folder>/pp/node_modules
  if (id.startsWith('phonemizer')) {
    const name = id === 'phonemizer' ? 'piper-phonemize-node' : 'piper-phonemize-win-x64'
    for (const r of [...roots(), path.join(__dirname, '..', 'models-dev')]) {
      const p = path.join(r, 'pp', 'node_modules', name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

/** is every part of a bundle installed? */
function ready(bundle) {
  return (BUNDLES[bundle] || []).every((id) => !!locate(id))
}

/** what a bundle still needs, with sizes, for the "may I download?" prompt */
function missing(bundle) {
  const items = (BUNDLES[bundle] || []).filter((id) => !locate(id)).map((id) => ({ id, ...MANIFEST[id], url: MANIFEST[id].url }))
  return { items, bytes: items.reduce((n, i) => n + i.bytes, 0) }
}

// ------------------------------------------------------------------------------------------------ download + verify + unpack
function download(url, file, onProgress, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    if (u.protocol !== 'https:') return reject(new Error('only https downloads are allowed'))
    https
      .get(u, { headers: { 'user-agent': 'Jarvis' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume()
          return resolve(download(new URL(res.headers.location, u).href, file, onProgress, redirects - 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`download failed: HTTP ${res.statusCode}`))
        }
        const total = +res.headers['content-length'] || 0
        let got = 0
        const out = fs.createWriteStream(file)
        res.on('data', (c) => {
          got += c.length
          if (onProgress) onProgress(got, total)
        })
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve(got)))
        out.on('error', reject)
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo)
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h)).on('error', reject)
  })
}

async function verify(file, m) {
  if (m.sha256) {
    const hex = (await hashFile(file, 'sha256')).digest('hex')
    if (hex !== m.sha256) throw new Error('checksum mismatch (SHA-256): the download was corrupted or replaced')
  } else if (m.integrity) {
    const [algo, b64] = m.integrity.split('-')
    const got = (await hashFile(file, algo)).digest('base64')
    if (got !== b64) throw new Error('checksum mismatch (npm integrity): the download was corrupted or replaced')
  } else throw new Error('no checksum pinned for this download')
}

/** list the archive first and refuse anything that could land outside the target folder */
function listArchive(tar, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-tf', file], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (c) => (out += c))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(out.split(/\r?\n/).filter(Boolean)) : reject(new Error('could not read the archive'))))
  })
}
function unsafeEntry(name) {
  const n = name.replace(/\\/g, '/')
  return n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..')
}
function extract(tar, file, dest, strip) {
  return new Promise((resolve, reject) => {
    const args = ['-xf', file, '-C', dest]
    if (strip) args.push('--strip-components=1')
    const p = spawn(tar, args, { windowsHide: true })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('could not unpack the archive'))))
  })
}
const tarExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')

/**
 * Install one item into <userData>/models. onProgress({id, got, total}).
 * Throws on any problem; a half-installed item is never left behind.
 */
async function install(id, onProgress = () => {}, deps = {}) {
  const m = MANIFEST[id]
  if (!m) throw new Error('unknown model ' + id)
  if (!userRoot && !process.env.JARVIS_MODELS_DIR) throw new Error('models folder not set')
  const root = process.env.JARVIS_MODELS_DIR || userRoot
  const dl = deps.download || download
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-model-'))
  const file = path.join(tmp, 'archive')
  try {
    await dl(m.url, file, (got, total) => onProgress({ id, got, total: total || m.bytes }))
    await verify(file, m)
    const tar = deps.tar || tarExe()
    const entries = await listArchive(tar, file)
    if (!entries.length || entries.some(unsafeEntry)) throw new Error('the archive contains unsafe paths; refusing to unpack')
    const dest = path.join(root, m.dir)
    const staging = path.join(root, '.staging-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(staging, { recursive: true })
    try {
      await extract(tar, file, staging, m.kind === 'npm') // npm tarballs wrap everything in "package/"; sherpa archives bring their own folder
      const unpacked = m.kind === 'npm' ? staging : path.join(staging, m.dir)
      if (!fs.existsSync(unpacked)) throw new Error('unpacked, but the expected folder is missing')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.rmSync(dest, { recursive: true, force: true })
      fs.renameSync(unpacked, dest)
    } finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
    return dest
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function installBundle(bundle, onProgress, deps) {
  for (const it of missing(bundle).items) await install(it.id, onProgress, deps)
}

const prettyBytes = (n) => (n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`)

module.exports = { MANIFEST, BUNDLES, setUserDir, roots, locate, ready, missing, install, installBundle, verify, unsafeEntry, prettyBytes }
