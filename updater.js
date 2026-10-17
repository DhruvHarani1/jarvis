'use strict'
/**
 * Self-updates from GitHub releases (electron-updater, blockmap = only changed blocks are downloaded).
 * The update installs when the app quits, or right away through install().
 * Downloaded installers live in a SIBLING of the install folder: the old uninstaller wipes the install
 * folder during an update, and it must not be able to delete the installer that is currently running.
 */
const { app } = require('electron')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const FIRST_CHECK_MS = 30_000
const EVERY_MS = 6 * 3600_000

function friendly(msg) {
  const m = String(msg || '')
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::|network/i.test(m)) return 'Couldn’t reach GitHub. Check your connection.'
  if (/404|Not Found|latest\.yml/i.test(m)) return 'No update information was found yet.'
  if (/rate limit|403/i.test(m)) return 'GitHub is rate limiting update checks. Try again later.'
  return m.slice(0, 160)
}

class Updater extends EventEmitter {
  constructor() {
    super()
    this.current = { state: 'idle' }
    this.timer = null
    this.started = false
    this.au = null
  }

  get state() {
    return this.current
  }

  set(s) {
    this.current = s
    this.emit('state', s)
  }

  start() {
    if (this.started) return
    this.started = true
    if (!app.isPackaged) {
      this.set({ state: 'disabled', reason: 'Updates only work in the installed app.' })
      return
    }
    const { autoUpdater } = require('electron-updater')
    this.au = autoUpdater
    this.useInstallFolderForDownloads()
    // test hook: point at a local feed, only when running under the test harness
    const feed = process.env.SPIDEY_TEST ? process.env.SPIDEY_UPDATE_FEED : ''
    if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = {
      info: (m) => console.log('[updater]', String(m)),
      warn: (m) => console.warn('[updater]', String(m)),
      error: (m) => console.error('[updater]', String(m)),
      debug: () => undefined
    }
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }))
    autoUpdater.on('update-available', (i) => this.set({ state: 'downloading', version: i.version, percent: 0 }))
    autoUpdater.on('download-progress', (p) => {
      const v = this.current.state === 'downloading' ? this.current.version : ''
      this.set({ state: 'downloading', version: v, percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', (i) => this.set({ state: 'ready', version: i.version }))
    autoUpdater.on('error', (e) => this.set({ state: 'error', message: friendly(e && e.message ? e.message : e) }))

    setTimeout(() => void this.check(), feed ? 3000 : FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), EVERY_MS)
  }

  useInstallFolderForDownloads() {
    try {
      const dir = `${path.dirname(process.execPath)}-updates`
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      Object.defineProperty(this.au.app, 'baseCachePath', { get: () => dir, configurable: true })
    } catch (e) {
      console.warn('[updater] could not use the install-folder cache; using the default', e.message)
    }
  }

  async check() {
    if (!app.isPackaged || !this.au) return this.current
    // don't disturb a finished or in-flight download
    if (['downloading', 'ready', 'checking'].includes(this.current.state)) return this.current
    try {
      await this.au.checkForUpdates()
    } catch (e) {
      this.set({ state: 'error', message: friendly(e && e.message) })
    }
    return this.current
  }

  install() {
    if (this.current.state === 'ready' && this.au) this.au.quitAndInstall(true, true) // silent, relaunch after
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
  }
}

module.exports = { updater: new Updater(), friendly }
