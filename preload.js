'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('collectorAPI', Object.freeze({
  start: config => ipcRenderer.invoke('collector:start', config),
  stop: runId => ipcRenderer.invoke('collector:stop', runId),
  getState: () => ipcRenderer.invoke('collector:state'),
  openOutput: () => ipcRenderer.invoke('collector:open-output'),
  onUpdate: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('collector:update', listener);
    return () => ipcRenderer.removeListener('collector:update', listener);
  }
}));

