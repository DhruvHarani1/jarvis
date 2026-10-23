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
  onTtsPlay: on('tts:play'),
  onTtsStop: on('tts:stop'),
  ttsEvent: (ev) => ipcRenderer.send('tts:event', ev),
  pickVoice: (pick) => ipcRenderer.invoke('voice:pick', pick),
  listVoices: () => ipcRenderer.invoke('voice:list'),
  brainReady: () => ipcRenderer.invoke('brain:ready'),
  brainChat: (text, ctx, opts) => ipcRenderer.invoke('brain:chat', text, ctx, opts),
  brainReset: () => ipcRenderer.send('brain:reset'),
  openBrain: () => ipcRenderer.send('brain:open'),
  onBrainDelta: on('brain:delta'),
  transcribe: (audio) => ipcRenderer.invoke('stt:transcribe', audio),
  voiceInfo: () => ipcRenderer.invoke('voice:info'),
  voiceListening: (isOn) => ipcRenderer.send('voice:listening', !!isOn),
  onVoiceToggle: on('voice:toggle'),
  onWakeState: on('wake:state'),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.send('update:install'),
  onUpdate: on('update:state'),
  showMenu: () => ipcRenderer.send('menu:show'),
  hide: () => ipcRenderer.send('window:hide')
})
