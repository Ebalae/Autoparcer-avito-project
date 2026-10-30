const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('avitoRadar', {
  getAccount: () => ipcRenderer.invoke('account:get'),
  refreshAccount: () => ipcRenderer.invoke('account:refresh'),
  login: (credentials) => ipcRenderer.invoke('account:login', credentials),
  logout: () => ipcRenderer.invoke('account:logout'),
  openAccountProfile: () => ipcRenderer.invoke('account:open-profile'),
  start: (config) => ipcRenderer.invoke('monitor:start', config),
  stop: (pageId) => ipcRenderer.invoke('monitor:stop', pageId),
  resume: (pageId) => ipcRenderer.invoke('monitor:resume', pageId),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  startWindowResize: (edge) => ipcRenderer.invoke('window:resize-start', edge),
  endWindowResize: () => ipcRenderer.invoke('window:resize-end'),
  onWindowState: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  onAccountState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('account:state', listener);
    return () => ipcRenderer.removeListener('account:state', listener);
  },
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('monitor:status', listener);
    return () => ipcRenderer.removeListener('monitor:status', listener);
  },
  onListings: (callback) => {
    const listener = (_event, listings) => callback(listings);
    ipcRenderer.on('monitor:listings', listener);
    return () => ipcRenderer.removeListener('monitor:listings', listener);
  }
});
