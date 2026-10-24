'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The setup window can look at what is ready and start the same actions as the tray menu. It never receives a key, a token or a model path.
contextBridge.exposeInMainWorld('welcomeApi', {
  state: () => ipcRenderer.invoke('welcome:state'),
  installModels: (bundles) => ipcRenderer.invoke('welcome:models', bundles),
  openBrain: () => ipcRenderer.send('welcome:brain'),
  openAccounts: () => ipcRenderer.send('welcome:accounts'),
  setWake: (on) => ipcRenderer.invoke('welcome:wake', !!on),
  finish: () => ipcRenderer.send('welcome:finish')
})
