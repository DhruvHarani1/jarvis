'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const on = (channel) => (cb) => {
  const l = (_e, v) => cb(v)
  ipcRenderer.on(channel, l)
  return () => ipcRenderer.removeListener(channel, l)
}

contextBridge.exposeInMainWorld('jarvis', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch) => ipcRenderer.send('settings:patch', patch),
  onSettings: on('settings'),
  onInbox: on('inbox'),
  onFocusInput: on('focus-input'),
  speak: (text, opts) => ipcRenderer.send('speak', text, opts),
  stopSpeaking: () => ipcRenderer.send('speak:stop'),
  onSpeechStart: on('speech:start'),
  onSpeechIdle: on('speech:idle'),
  onHudStats: on('hud:stats'),
  onAssistantLine: on('assistant:line'),
  onTtsPlay: on('tts:play'),
  onTtsStop: on('tts:stop'),
  ttsEvent: (ev) => ipcRenderer.send('tts:event', ev),
  pickVoice: (pick) => ipcRenderer.invoke('voice:pick', pick),
  listVoices: () => ipcRenderer.invoke('voice:list'),
  onConfirmAsk: on('confirm:ask'),
  onConfirmClose: on('confirm:close'),
  confirmAnswer: (id, yes) => ipcRenderer.send('confirm:answer', id, !!yes),
  fastTry: (text) => ipcRenderer.invoke('fast:try', text),
  brainReady: () => ipcRenderer.invoke('brain:ready'),
  brainChat: (text, ctx, opts) => ipcRenderer.invoke('brain:chat', text, ctx, opts),
  brainReset: () => ipcRenderer.send('brain:reset'),
  onBrainDelta: on('brain:delta'),
  onSettingsPage: on('settings:page'),
  transcribe: (audio) => ipcRenderer.invoke('stt:transcribe', audio),
  voiceInfo: () => ipcRenderer.invoke('voice:info'),
  voiceListening: (isOn) => ipcRenderer.send('voice:listening', !!isOn),
  onVoiceToggle: on('voice:toggle'),
  onWakeState: on('wake:state'),
  onWakeEnable: on('wake:enable'),
  onWakePause: on('wake:pause'),
  wakePcm: (samples) => ipcRenderer.send('wake:pcm', samples),
  wakeMic: (ev) => ipcRenderer.send('wake:mic', ev),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.send('update:install'),
  onUpdate: on('update:state'),
  showMenu: () => ipcRenderer.send('menu:show'),
  hide: () => ipcRenderer.send('window:hide')
})

// The window that holds the settings pages is the only window, so the three page APIs live here. None of them can read a secret back:
// main returns masked key hints, who is connected and what they allowed, and what is installed. Never a key, token or model path.
contextBridge.exposeInMainWorld('brainApi', {
  state: () => ipcRenderer.invoke('brainwin:state'),
  add: (entry) => ipcRenderer.invoke('brainwin:add', entry),
  update: (id, patch) => ipcRenderer.invoke('brainwin:update', id, patch),
  remove: (id) => ipcRenderer.invoke('brainwin:remove', id),
  move: (id, dir) => ipcRenderer.invoke('brainwin:move', id, dir),
  test: (id) => ipcRenderer.invoke('brainwin:test', id),
  natural: (on) => ipcRenderer.invoke('brainwin:natural', on),
  smart: (on) => ipcRenderer.invoke('brainwin:smart', on),
  openLink: (url) => ipcRenderer.send('brainwin:link', url)
})
contextBridge.exposeInMainWorld('acctApi', {
  state: () => ipcRenderer.invoke('acct:state'),
  addGoogle: (form) => ipcRenderer.invoke('acct:add-google', form),
  reconnect: (id) => ipcRenderer.invoke('acct:reconnect', id),
  remove: (id) => ipcRenderer.invoke('acct:remove', id),
  openGuide: (name) => ipcRenderer.send('acct:guide', name)
})
contextBridge.exposeInMainWorld('welcomeApi', {
  state: () => ipcRenderer.invoke('welcome:state'),
  installModels: (bundles) => ipcRenderer.invoke('welcome:models', bundles),
  setWake: (on) => ipcRenderer.invoke('welcome:wake', !!on),
  finish: () => ipcRenderer.send('welcome:finish')
})
