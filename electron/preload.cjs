const { contextBridge, ipcRenderer } = require('electron');

// Optional bridge for future native APIs; renderer works unchanged without it.
const desktopBridge = {
  platform: process.platform,
  onSpellcheckMenuState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('orchestra-spellcheck-menu-state', listener);
    return () => {
      ipcRenderer.removeListener('orchestra-spellcheck-menu-state', listener);
    };
  },
};
contextBridge.exposeInMainWorld('orchestraDesktop', desktopBridge);
contextBridge.exposeInMainWorld('agentTaskTrackerDesktop', desktopBridge);
