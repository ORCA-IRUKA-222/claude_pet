'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['state', 'transition', 'config', 'pet', 'command', 'quick-event']);

contextBridge.exposeInMainWorld('pet', {
  init: () => ipcRenderer.invoke('init'),
  on(channel, listener) {
    if (!EVENTS.has(channel)) throw new Error(`unknown channel ${channel}`);
    ipcRenderer.on(channel, (_event, payload) => listener(payload));
  },
  resize: (width, height) => ipcRenderer.send('resize', { width, height }),
  dragStart: (x, y) => ipcRenderer.send('drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('drag-end'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  focus: () => ipcRenderer.send('focus'),
  hide: () => ipcRenderer.send('hide'),
  setMini: (mini) => ipcRenderer.send('set-mini', mini),
  markRead: (id) => ipcRenderer.send('mark-read', id),
  markAllRead: () => ipcRenderer.send('mark-all-read'),
  dismiss: (id) => ipcRenderer.send('dismiss', id),
  copy: (text) => ipcRenderer.send('copy', text),
  openTerminal: (sessionId, cwd) => ipcRenderer.invoke('open-terminal', { sessionId, cwd }),
  quickSend: (prompt, cwd, resume) => ipcRenderer.invoke('quick-send', { prompt, cwd, resume }),
  quickStop: () => ipcRenderer.send('quick-stop'),
  chooseFolder: (current) => ipcRenderer.invoke('choose-folder', current),
});
