'use strict'
/**
 * Composition root for Jarvis's hands: builds the activity log, the reminder scheduler, the file sandbox, the tool runtime with
 * the built-in tools, and the agent loop, from the pieces Electron provides. main.js only calls create() once the app is ready.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const audit = require('./tools/audit')
const scheduler = require('./tools/scheduler')
const { createSandbox } = require('./tools/paths')
const { createRuntime } = require('./tools/runtime')
const { createTools, FOLDERS } = require('./tools/windows')
const psReal = require('./tools/ps')
const { createSpotifyTools } = require('./tools/spotify')
const { createGoogleTools } = require('./tools/google')
const { createAgent } = require('./agent')

/**
 * @param {{electron:{app:any, shell:any, clipboard:any}, userData:string, brain:()=>any, settings:()=>any, confirm:(req:any)=>Promise<boolean>,
 *          onReminder:(r:any)=>void, ps?:Function}} o
 */
function create({ electron, userData, brain, settings, confirm, onReminder, ps, google, accountStore }) {
  const auditLog = audit.create({ file: path.join(userData, 'activity.jsonl') })
  const sched = scheduler.create({ file: path.join(userData, 'reminders.json'), onFire: onReminder })
  const folderPath = (name) => {
    try {
      return electron.app.getPath(name)
    } catch {
      return null
    }
  }
  const testRoot = process.env.SPIDEY_TEST && process.env.JARVIS_TEST_ROOT // tests keep file tools inside a throw-away folder
  const sandbox = createSandbox(testRoot ? [testRoot] : FOLDERS.map(folderPath).filter((p) => p && fs.existsSync(p)))
  const runtime = createRuntime({ audit: auditLog, confirm, powerMode: () => !!settings().powerMode, disabled: () => settings().disabledTools || [] })
  // tests record what would have been opened instead of opening it on the real PC
  const shell = process.env.SPIDEY_TEST && process.env.JARVIS_TEST_PS_LOG
    ? {
        openExternal: async (u) => fs.appendFileSync(process.env.JARVIS_TEST_PS_LOG, JSON.stringify({ which: 'openExternal', arg: u }) + '\n'),
        openPath: async (p) => (fs.appendFileSync(process.env.JARVIS_TEST_PS_LOG, JSON.stringify({ which: 'openPath', arg: p }) + '\n'), '')
      }
    : electron.shell
  const tools = createTools({
    ps: ps || ((script, arg) => psReal.run(script, arg)),
    shell,
    clipboard: process.env.SPIDEY_TEST && process.env.JARVIS_TEST_CLIPBOARD ? { readText: () => process.env.JARVIS_TEST_CLIPBOARD, writeText() {} } : electron.clipboard,
    scheduler: sched,
    sandbox,
    fs,
    os,
    folder: folderPath
  })
  const runPs = ps || ((script, arg) => psReal.run(script, arg))
  for (const t of [...tools, ...createSpotifyTools({ ps: runPs, shell }), ...(google && accountStore ? createGoogleTools({ google, store: accountStore }) : [])]) runtime.register(t)
  const agent = createAgent({ brain: { chat: (m, d, o) => brain().chat(m, d, o) }, runtime })
  sched.start()
  return { runtime, agent, audit: auditLog, scheduler: sched, sandbox, toolList: () => runtime.tiers() }
}

module.exports = { create }
