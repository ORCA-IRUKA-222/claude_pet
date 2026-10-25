'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set([
  'state',
  'transition',
  'config',
  'pet',
  'command',
  'quick-event',
  'timers',
  'memos',
  'calendar',
  'alarm',
  'digest',
  'attach',
  'say',
]);

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
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openTerminal: (sessionId, cwd) => ipcRenderer.invoke('open-terminal', { sessionId, cwd }),
  quickSend: (prompt, cwd, resume, attachments) => ipcRenderer.invoke('quick-send', { prompt, cwd, resume, attachments }),
  quickStop: () => ipcRenderer.send('quick-stop'),
  chooseFolder: (current) => ipcRenderer.invoke('choose-folder', current),

  // Claude Code sessions
  answerPermission: (id, behavior) => ipcRenderer.send('permission-answer', { id, behavior }),
  pauseSession: (id) => ipcRenderer.send('pause-session', id),
  cancelPause: (id) => ipcRenderer.send('cancel-pause', id),
  openFile: (sessionId, file, reveal = false) => ipcRenderer.invoke('open-file', { sessionId, file, reveal }),

  // Drag & drop and screenshots
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  screenshot: () => ipcRenderer.invoke('screenshot'),

  // Tools
  timer: (action, value) => ipcRenderer.invoke('timer', { action, value }),
  memo: (request) => ipcRenderer.invoke('memo', request),
  calendarSetUrl: (url) => ipcRenderer.invoke('calendar-set-url', url),
  calendarRefresh: () => ipcRenderer.send('calendar-refresh'),
});
