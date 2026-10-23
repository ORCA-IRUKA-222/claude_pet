'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  Notification,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');

const { APP_ROOT, getPort, homeDir, loadConfig, saveConfig } = require('../shared/config');
const { translator } = require('../shared/i18n');
const { SessionTracker } = require('../core/sessions');
const { startServer } = require('../core/server');
const { listPets, findPet } = require('../core/pets');
const { QuickChat } = require('../core/quickchat');
const { openInTerminal } = require('../core/terminal');
const installer = require('../core/installer');
const { version } = require('../../package.json');

const SCALES = { small: 0.5, medium: 0.75, large: 1 };

const config = loadConfig();
let t = translator(config.language);
let win = null;
let tray = null;
let pet = null;
let anchor = null; // bottom-centre of the pet, in screen coordinates
let drag = null;
let saveTimer = null;
let quitting = false;

const tracker = new SessionTracker({ staleMs: config.staleMinutes * 60e3 });
const quickChat = new QuickChat({
  claudePath: config.claudePath,
  permissionMode: config.quickChat.permissionMode,
  model: config.quickChat.model,
});
quickChat.on('event', (ev) => sendToRenderer('quick-event', ev));

function persist(changes) {
  Object.assign(config, changes);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveConfig(config), 300);
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function petForRenderer(p) {
  if (!p) return null;
  return {
    key: p.key,
    displayName: p.displayName,
    kind: p.kind,
    url: pathToFileURL(p.file).href,
    width: p.width,
    height: p.height,
    cellWidth: p.cellWidth,
    cellHeight: p.cellHeight,
    rows: p.rows,
    pixelArt: p.pixelArt,
  };
}

function rendererConfig() {
  return {
    scale: config.scale,
    mini: config.mini,
    showBubble: config.showBubble,
    language: config.language,
    quickChatCwd: config.quickChat.cwd || app.getPath('home'),
    home: app.getPath('home'),
  };
}

function pushState() {
  sendToRenderer('state', { sessions: tracker.list(), aggregate: tracker.aggregate() });
  updateTray();
}

// ---------------------------------------------------------------- window

function defaultAnchor() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - 140, y: area.y + area.height - 24 };
}

function clampAnchor(point, width, height) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
  const area = display.workArea;
  return {
    x: Math.min(Math.max(point.x, area.x + width / 2), area.x + area.width - width / 2),
    y: Math.min(Math.max(point.y, area.y + height), area.y + area.height),
  };
}

function applyBounds(width, height) {
  if (!win) return;
  const w = Math.max(40, Math.ceil(width));
  const h = Math.max(40, Math.ceil(height));
  anchor = clampAnchor(anchor, w, h);
  win.setBounds({ x: Math.round(anchor.x - w / 2), y: Math.round(anchor.y - h), width: w, height: h });
}

function createWindow() {
  anchor = config.position && Number.isFinite(config.position.x) ? { ...config.position } : defaultAnchor();
  win = new BrowserWindow({
    width: 120,
    height: 140,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    title: 'Claude Pet',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      setVisible(false);
    }
  });

  win.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (config.visible) win.showInactive();
  });
}

function setVisible(visible) {
  if (!win) return;
  if (visible) win.showInactive();
  else win.hide();
  persist({ visible });
  updateTray();
}

function setMini(mini) {
  persist({ mini });
  sendToRenderer('config', rendererConfig());
  updateTray();
}

function setPet(key) {
  const next = findPet(key);
  if (!next) return null;
  pet = next;
  persist({ pet: next.key });
  sendToRenderer('pet', petForRenderer(pet));
  updateTray();
  return pet;
}

// ---------------------------------------------------------------- menus

function buildMenu() {
  const pets = listPets();
  const scaleKey = Object.keys(SCALES).find((k) => SCALES[k] === config.scale) || 'small';
  const visible = Boolean(win && win.isVisible());
  return Menu.buildFromTemplate([
    { label: t('menu.sessions'), click: () => openPanel('sessions') },
    { label: t('menu.quickChat'), accelerator: config.shortcuts.quickChat || undefined, click: () => openQuickChat() },
    { type: 'separator' },
    {
      label: t('menu.pets'),
      submenu: [
        ...pets.map((p) => ({
          label: `${p.displayName}${p.origin === 'builtin' ? '' : `  (${p.origin})`}`,
          type: 'radio',
          checked: pet && p.key === pet.key,
          click: () => setPet(p.key),
        })),
        { type: 'separator' },
        { label: t('menu.reloadPets'), click: () => setPet(config.pet) },
        { label: t('menu.openPetsFolder'), click: () => openPetsFolder() },
      ],
    },
    {
      label: t('menu.size'),
      submenu: Object.keys(SCALES).map((k) => ({
        label: t(`menu.size.${k}`),
        type: 'radio',
        checked: k === scaleKey,
        click: () => {
          persist({ scale: SCALES[k] });
          sendToRenderer('config', rendererConfig());
        },
      })),
    },
    { label: t('menu.mini'), type: 'checkbox', checked: config.mini, click: (item) => setMini(item.checked) },
    {
      label: t('menu.bubble'),
      type: 'checkbox',
      checked: config.showBubble,
      click: (item) => {
        persist({ showBubble: item.checked });
        sendToRenderer('config', rendererConfig());
      },
    },
    {
      label: t('menu.notifications'),
      type: 'checkbox',
      checked: config.notifications,
      click: (item) => persist({ notifications: item.checked }),
    },
    {
      label: t('menu.alwaysOnTop'),
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        persist({ alwaysOnTop: item.checked });
        if (win) win.setAlwaysOnTop(item.checked, 'floating');
      },
    },
    {
      label: t('menu.language'),
      submenu: [
        ['ja', '日本語'],
        ['en', 'English'],
      ].map(([code, label]) => ({
        label,
        type: 'radio',
        checked: config.language === code,
        click: () => {
          persist({ language: code });
          t = translator(code);
          sendToRenderer('config', rendererConfig());
          updateTray();
        },
      })),
    },
    { type: 'separator' },
    visible
      ? { label: t('menu.hide'), accelerator: config.shortcuts.toggle || undefined, click: () => setVisible(false) }
      : { label: t('menu.show'), accelerator: config.shortcuts.toggle || undefined, click: () => setVisible(true) },
    { label: t('menu.quit'), click: () => quit() },
  ]);
}

function trayIcon() {
  const icon = nativeImage.createFromPath(path.join(APP_ROOT, 'assets', 'tray.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(false);
  return icon.resize({ width: 18, height: 18, quality: 'best' });
}

function updateTray() {
  if (!tray) return;
  const agg = tracker.aggregate();
  const attention = agg.counts.waiting + agg.counts.failed + agg.counts.ready;
  tray.setToolTip(`Claude Pet — ${t(`status.${agg.status}`)}${attention ? ` (${attention})` : ''}`);
  if (process.platform === 'darwin') tray.setTitle(attention ? String(attention) : '');
  tray.setContextMenu(buildMenu());
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.on('click', () => {
      if (process.platform !== 'darwin') setVisible(!(win && win.isVisible()));
    });
    updateTray();
  } catch {
    tray = null; // Some Linux desktops have no tray; the right-click menu still works.
  }
}

function openPetsFolder() {
  const dir = path.join(homeDir(), 'pets');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

function openPanel(tab) {
  setVisible(true);
  sendToRenderer('command', { type: 'panel', tab });
}

function focusWindow() {
  if (!win) return;
  // The app has no Dock icon on macOS, so it must take focus explicitly to receive typing.
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
}

function openQuickChat() {
  setVisible(true);
  focusWindow();
  sendToRenderer('command', { type: 'quickchat' });
}

// ---------------------------------------------------------------- notifications

function notifyTransition({ session, to }) {
  sendToRenderer('transition', { session, to });
  if (!config.notifications || !Notification.isSupported()) return;
  if (!['waiting', 'ready', 'failed'].includes(to) || session.source === 'quickchat') return;
  if (to === 'ready' && !session.unread) return;
  const body = to === 'ready' ? session.message || '' : session.detail || session.message || '';
  new Notification({
    title: t(`notify.${to}`, { project: session.title || session.project }),
    body: body.slice(0, 200),
    silent: to === 'ready',
  }).show();
}

// ---------------------------------------------------------------- control (CLI / slash command)

async function handleControl({ action, value }) {
  switch (action) {
    case 'toggle': {
      const next = !(win && win.isVisible());
      setVisible(next);
      return { visible: next };
    }
    case 'show':
      setVisible(true);
      return { visible: true };
    case 'hide':
      setVisible(false);
      return { visible: false };
    case 'mini':
      setVisible(true);
      setMini(Boolean(value));
      return { mini: config.mini };
    case 'quickchat':
      openQuickChat();
      return {};
    case 'set-pet': {
      const p = setPet(String(value || ''));
      if (!p) throw Object.assign(new Error('pet not found'), { status: 404 });
      return { pet: p.key };
    }
    case 'quit':
      setTimeout(quit, 50);
      return {};
    default:
      throw Object.assign(new Error(`unknown action: ${action}`), { status: 400 });
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('init', () => ({
    config: rendererConfig(),
    pet: petForRenderer(pet),
    state: { sessions: tracker.list(), aggregate: tracker.aggregate() },
    hooksInstalled: installer.isInstalled(),
    version,
  }));

  ipcMain.on('resize', (_e, size) => {
    if (!drag && size && Number.isFinite(size.width) && Number.isFinite(size.height)) applyBounds(size.width, size.height);
  });

  ipcMain.on('drag-start', (_e, p) => {
    drag = { cursor: p, anchor: { ...anchor } };
  });
  ipcMain.on('drag-move', (_e, p) => {
    if (!drag || !win) return;
    const bounds = win.getBounds();
    anchor = { x: drag.anchor.x + (p.x - drag.cursor.x), y: drag.anchor.y + (p.y - drag.cursor.y) };
    win.setBounds({ ...bounds, x: Math.round(anchor.x - bounds.width / 2), y: Math.round(anchor.y - bounds.height) });
  });
  ipcMain.on('drag-end', () => {
    if (!drag || !win) return;
    drag = null;
    const bounds = win.getBounds();
    applyBounds(bounds.width, bounds.height);
    persist({ position: { ...anchor } });
  });

  ipcMain.on('context-menu', () => buildMenu().popup({ window: win }));
  ipcMain.on('focus', focusWindow);
  ipcMain.on('hide', () => setVisible(false));
  ipcMain.on('set-mini', (_e, mini) => setMini(Boolean(mini)));
  ipcMain.on('mark-read', (_e, id) => tracker.markRead(String(id)));
  ipcMain.on('mark-all-read', () => tracker.markAllRead());
  ipcMain.on('dismiss', (_e, id) => tracker.dismiss(String(id)));
  ipcMain.on('copy', (_e, text) => clipboard.writeText(String(text || '')));

  ipcMain.handle('open-terminal', async (_e, { sessionId, cwd }) => {
    try {
      await openInTerminal({ sessionId, cwd, claudePath: config.claudePath, template: config.terminalCommand });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('quick-send', (_e, { prompt, cwd, resume }) => {
    try {
      const { cwd: used } = quickChat.send({ prompt, cwd, resume });
      persist({ quickChat: { ...config.quickChat, cwd: used } });
      return { ok: true, cwd: used };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.on('quick-stop', () => quickChat.stop());

  ipcMain.handle('choose-folder', async (_e, current) => {
    const result = await dialog.showOpenDialog(win, {
      defaultPath: current || app.getPath('home'),
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

// ---------------------------------------------------------------- lifecycle

function registerShortcuts() {
  const { toggle, quickChat: chat } = config.shortcuts || {};
  try {
    if (toggle) globalShortcut.register(toggle, () => setVisible(!(win && win.isVisible())));
    if (chat) globalShortcut.register(chat, () => openQuickChat());
  } catch {
    // An invalid or already-taken accelerator shouldn't stop the app.
  }
}

function quit() {
  quitting = true;
  clearTimeout(saveTimer);
  saveConfig(config);
  app.quit();
}

async function boot() {
  try {
    await startServer({
      port: getPort(),
      version,
      onEvent: (event) => tracker.handle(event),
      onControl: handleControl,
      getStatus: () => ({ visible: Boolean(win && win.isVisible()), sessions: tracker.list(), aggregate: tracker.aggregate() }),
    });
  } catch (err) {
    dialog.showErrorBox('Claude Pet', `ポート ${getPort()} を使えませんでした: ${err.message}`);
    app.exit(1);
    return;
  }

  pet = findPet(config.pet);
  tracker.on('change', pushState);
  tracker.on('transition', notifyTransition);
  setInterval(() => tracker.prune(), 60e3).unref();

  registerIpc();
  createWindow();
  createTray();
  registerShortcuts();
  screen.on('display-removed', () => {
    if (win) applyBounds(win.getBounds().width, win.getBounds().height);
  });
}

if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');
app.setAppUserModelId('dev.claude-pet');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => setVisible(true));
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    quitting = true;
    quickChat.stop();
  });
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    // Linux compositors need a moment before transparent windows render correctly.
    setTimeout(boot, process.platform === 'linux' ? 300 : 0);
  });
}
