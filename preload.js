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
  openBrain: () => ipcRenderer.send('brain:open'),
  openAccounts: () => ipcRenderer.send('accounts:open'),
  onBrainDelta: on('brain:delta'),
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
