'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The Accounts window can connect, reconnect and remove accounts. It never receives a token or a secret: main only returns who is connected and what they allowed.
contextBridge.exposeInMainWorld('acctApi', {
  state: () => ipcRenderer.invoke('acct:state'),
  addGoogle: (form) => ipcRenderer.invoke('acct:add-google', form),
  reconnect: (id) => ipcRenderer.invoke('acct:reconnect', id),
  remove: (id) => ipcRenderer.invoke('acct:remove', id),
  openGuide: (name) => ipcRenderer.send('acct:guide', name)
})
