'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('collectorAPI', Object.freeze({
  start: config => ipcRenderer.invoke('collector:start', config),
  stop: runId => ipcRenderer.invoke('collector:stop', runId),
  getState: () => ipcRenderer.invoke('collector:state'),
  openOutput: () => ipcRenderer.invoke('collector:open-output'),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  prepareAccount: options => ipcRenderer.invoke('accounts:prepare', options),
  cancelAccountPreparation: () => ipcRenderer.invoke('accounts:cancel-prepare'),
  onAccountUpdate: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('account:update', listener);
    return () => ipcRenderer.removeListener('account:update', listener);
  },
  onUpdate: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('collector:update', listener);
    return () => ipcRenderer.removeListener('collector:update', listener);
  }
}));
