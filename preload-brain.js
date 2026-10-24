'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The settings window can add/replace keys but can never read one back: main only returns masked hints.
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
