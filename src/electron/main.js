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
const { translator, formatMinutes } = require('../shared/i18n');
const { SessionTracker } = require('../core/sessions');
const { startServer } = require('../core/server');
const { listPets, findPet } = require('../core/pets');
const { QuickChat, CLOUD_ID, modelArgs } = require('../core/quickchat');
const { recentSessions, findTranscript, readConversation } = require('../core/history');
const rotation = require('../core/rotation');
const { openInTerminal, openCloudTask } = require('../core/terminal');
const installer = require('../core/installer');
const autostart = require('../core/autostart');
const { findClaude, isClaudeExecutable } = require('../core/claude-path');
const { RelayListener } = require('../core/relay');
const { loadCloudSessions, saveCloudSessions } = require('../core/cloud-store');
const { cloneRepo, remember, listGitHubRepos, isCloned } = require('../core/repos');
const { version } = require('../../package.json');
const { buildId } = require('../shared/build');

const SCALES = { small: 0.5, medium: 0.75, large: 1 };
const ROTATION_INTERVALS = [15, 30, 60, 120, 180];

const config = loadConfig();
let t = translator(config.language);
let win = null;
let tray = null;
let pet = null;
let startsAtLogin = false;
let relay = null; // cloud sessions, see src/core/relay.js
let anchor = null; // bottom-centre of the pet, in screen coordinates
let drag = null;
let saveTimer = null;
let quitting = false;

const tracker = new SessionTracker({ staleMs: config.staleMinutes * 60e3 });
// The pet asks the strongest model by default; weaker ones only if chosen in the menu.
const MODELS = [
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
];
const EFFORT_LEVELS = ['medium', 'high', 'xhigh', 'max'];
const currentModel = () => config.quickChat.model || MODELS[0][0];
const currentEffort = () => config.quickChat.effort || 'xhigh';

const claudeCommand = () => findClaude({ configured: config.claudePath, learned: config.learnedClaudePath });
const quickChat = new QuickChat({
  claudePath: claudeCommand,
  permissionMode: config.quickChat.permissionMode,
  model: currentModel(),
  effort: currentEffort(),
});

/** --model / --effort for a Claude Code the pet starts in a terminal. */
const terminalModelArgs = () => modelArgs({ model: currentModel(), effort: quickChat.noEffort ? null : currentEffort() });

function setModel(changes) {
  persist({ quickChat: { ...config.quickChat, ...changes } });
  quickChat.model = currentModel();
  quickChat.effort = currentEffort();
  sendToRenderer('config', rendererConfig());
}
quickChat.on('event', (ev) => {
  sendToRenderer('quick-event', ev);
  quickChatToApp(ev);
  if (ev.type === 'interactive-only') {
    pendingCloudTasks.push({ prompt: ev.prompt, at: Date.now() });
    const opts = { cwd: ev.cwd, claudePath: claudeCommand(), task: ev.prompt, extraArgs: terminalModelArgs() };
    openCloudTask({ ...opts, template: config.terminalCommand }).catch((err) =>
      sendToRenderer('quick-event', { type: 'error', message: err.message }),
    );
  }
});

// Cloud tasks started in a terminal, waiting to learn their cloud session from the relay so
// the quick chat can send follow-ups to it (claude -p --cloud <session>).
const pendingCloudTasks = [];
const sameStart = (a, b) => {
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/…$/, '');
  const x = norm(a);
  const y = norm(b);
  const n = Math.min(x.length, y.length, 60);
  return n > 0 && x.slice(0, n) === y.slice(0, n);
};

function linkCloudTask(event) {
  if (event.event !== 'UserPromptSubmit' || typeof event.url !== 'string') return;
  const m = /\/code\/(session_[A-Za-z0-9]+)$/.exec(event.url);
  const i = pendingCloudTasks.findIndex((p) => Date.now() - p.at < 30 * 60e3 && sameStart(p.prompt, event.prompt));
  if (!m || i < 0) return;
  const [task] = pendingCloudTasks.splice(i, 1);
  sendToRenderer('quick-event', { type: 'cloud-linked', prompt: task.prompt, cloudSessionId: m[1], url: event.url });
}

function persist(changes) {
  Object.assign(config, changes);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveConfig(config), 300);
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function petForRenderer(p, announce = false) {
  if (!p) return null;
  return {
    announce,
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
    displayHeight: p.displayHeight || null,
    states: Object.fromEntries(
      Object.entries(p.states || {}).map(([state, info]) => [
        state,
        { url: pathToFileURL(info.file).href, width: info.width, height: info.height },
      ]),
    ),
  };
}

function rendererConfig() {
  return {
    scale: config.scale,
    mini: config.mini,
    showBubble: config.showBubble,
    language: config.language,
    quickChatCwd: config.quickChat.cwd || app.getPath('home'),
    quickChatTarget: config.quickChat.target || 'local',
    quickChatModel: (MODELS.find(([id]) => id === currentModel()) || [null, currentModel()])[1],
    quickChatEffort: currentEffort(),
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

function setPet(key, { announce = false } = {}) {
  const next = findPet(key);
  if (!next) return null;
  pet = next;
  persist({ pet: next.key });
  sendToRenderer('pet', petForRenderer(pet, announce));
  updateTray();
  return pet;
}

/** A pet picked by hand stays for a full interval before the rotation moves on. */
function choosePet(key) {
  const chosen = setPet(key);
  if (chosen) persist({ rotation: { ...config.rotation, lastChangedAt: Date.now() } });
  return chosen;
}

// ---------------------------------------------------------------- rotation

function rotationCandidates() {
  return rotation.candidates(listPets(), config.rotation);
}

function rotateNow() {
  const { next, queue } = rotation.pickNext(rotationCandidates(), pet && pet.key, {
    order: rotation.normalizeOrder(config.rotation.order),
    queue: config.rotation.queue,
  });
  persist({ rotation: { ...config.rotation, queue, lastChangedAt: Date.now() } });
  return next ? setPet(next, { announce: true }) : null;
}

function checkRotation() {
  if (rotation.isDue(config.rotation)) rotateNow();
}

function updateRotation(patch) {
  const before = config.rotation;
  const next = { ...before, ...patch };
  if (patch.group !== undefined || patch.pets !== undefined) next.queue = [];
  persist({ rotation: next });
  if (next.enabled) {
    const keys = rotationCandidates();
    // Switching the rotation on (or to another group) brings in a pet from that set right away.
    if (!before.enabled || !keys.includes(pet && pet.key)) rotateNow();
  }
  updateTray();
  return rotationStatus();
}

function rotationStatus() {
  return { rotation: config.rotation, count: rotationCandidates().length, pet: pet && pet.key, petName: pet && pet.displayName };
}

// ---------------------------------------------------------------- menus

function buildMenu() {
  const pets = listPets();
  const petItem = (p) => ({
    label: `${p.displayName}${p.origin === 'builtin' || p.origin === 'custom' ? '' : `  (${p.origin})`}`,
    type: 'radio',
    checked: Boolean(pet && p.key === pet.key),
    click: () => choosePet(p.key),
  });
  const scaleKey = Object.keys(SCALES).find((k) => SCALES[k] === config.scale) || 'small';
  const visible = Boolean(win && win.isVisible());
  return Menu.buildFromTemplate([
    { label: t('menu.sessions'), click: () => openPanel('sessions') },
    { label: t('menu.quickChat'), accelerator: config.shortcuts.quickChat || undefined, click: () => openQuickChat() },
    { type: 'separator' },
    {
      label: t('menu.pets'),
      submenu: [
        ...pets.filter((p) => !p.group).map(petItem),
        ...rotation.groups(pets).map((group) => ({ label: group, submenu: pets.filter((p) => p.group === group).map(petItem) })),
        { type: 'separator' },
        { label: t('menu.reloadPets'), click: () => setPet(config.pet) },
        { label: t('menu.openPetsFolder'), click: () => openPetsFolder() },
      ],
    },
    {
      label: t('menu.rotation'),
      submenu: [
        {
          label: t('menu.rotation.enabled'),
          type: 'checkbox',
          checked: config.rotation.enabled,
          click: (item) => updateRotation({ enabled: item.checked }),
        },
        { label: t('menu.rotation.next'), click: () => rotateNow() },
        { type: 'separator' },
        ...ROTATION_INTERVALS.map((minutes) => ({
          label: t('menu.rotation.every', { label: formatMinutes(t, minutes) }),
          type: 'radio',
          checked: Number(config.rotation.intervalMinutes) === minutes,
          click: () => updateRotation({ intervalMinutes: minutes }),
        })),
        { type: 'separator' },
        { label: t('menu.rotation.target'), enabled: false },
        {
          label: t('menu.rotation.all'),
          type: 'radio',
          checked: !config.rotation.group && !(config.rotation.pets || []).length,
          click: () => updateRotation({ group: null, pets: [] }),
        },
        ...rotation.groups(pets).map((group) => ({
          label: group,
          type: 'radio',
          checked: config.rotation.group === group && !(config.rotation.pets || []).length,
          click: () => updateRotation({ group, pets: [] }),
        })),
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
      label: t('menu.model'),
      submenu: [
        ...MODELS.map(([id, label]) => ({
          label,
          type: 'radio',
          checked: currentModel() === id,
          click: () => setModel({ model: id }),
        })),
        { type: 'separator' },
        ...EFFORT_LEVELS.map((level) => ({
          label: t('menu.effort', { level: t(`effort.${level}`) }),
          type: 'radio',
          checked: currentEffort() === level,
          click: () => setModel({ effort: level }),
        })),
      ],
    },
    {
      label: t('menu.quickChatToApp'),
      type: 'checkbox',
      checked: Boolean(config.quickChat.openInApp),
      click: (item) => persist({ quickChat: { ...config.quickChat, openInApp: item.checked } }),
    },
    {
      label: t('menu.autostart'),
      type: 'checkbox',
      checked: startsAtLogin,
      click: (item) => setAutostart(item.checked),
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

function learnClaudePath(file) {
  if (!file || file === config.learnedClaudePath || !isClaudeExecutable(file)) return;
  persist({ learnedClaudePath: file });
}

// ---------------------------------------------------------------- Claude desktop app

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const openedInApp = new Set();

/** The same link `claude --desktop --resume <id>` opens, without needing a console. */
async function openInApp(sessionId) {
  if (!SESSION_UUID.test(String(sessionId || ''))) throw new Error('invalid session id');
  openedInApp.add(sessionId);
  await shell.openExternal(`claude://resume?session=${sessionId}`);
}

/** With quickChat.openInApp on, a new quick chat also opens in the app once it has its first reply. */
function quickChatToApp(ev) {
  if (!config.quickChat.openInApp || ev.type !== 'done' || !ev.sessionId || openedInApp.has(ev.sessionId)) return;
  openInApp(ev.sessionId).catch(() => {});
}

// ---------------------------------------------------------------- cloud sessions

let cloudSaveTimer = null;
// What each cloud session said, as far as the relay carried it (prompts and final replies):
// the pet shows this when a cloud session is opened in it.
const cloudLogs = new Map();
const cloudIdOf = (url) => (/\/code\/(session_[A-Za-z0-9]+)/.exec(String(url || '')) || [])[1] || null;

function appendCloudLog(e) {
  const role = e.event === 'UserPromptSubmit' ? 'user' : e.event === 'Stop' ? 'assistant' : null;
  const text = role === 'user' ? e.prompt : e.message;
  if (!role || typeof text !== 'string' || !text.trim()) return;
  const log = cloudLogs.get(e.session_id) || [];
  const last = log[log.length - 1];
  if (last && last.role === role && last.text === text) return; // the same event again
  log.push({ role, text });
  cloudLogs.set(e.session_id, log.slice(-40));
  sendToRenderer('quick-event', { type: 'cloud-message', cloudId: cloudIdOf(e.url), role, text });
}

/** Remember the cloud sessions in the list, so they are back after a restart. */
function saveCloudSoon() {
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => {
    try {
      const sessions = tracker.list().map((s) => (s.source === 'cloud' ? { ...s, messages: cloudLogs.get(s.id) || [] } : s));
      saveCloudSessions(sessions, relay ? relay.lastId : loadCloudSessions().lastId);
    } catch (err) {
      console.error('[claude-pet] cloud sessions:', err.message);
    }
  }, 2000);
}

function startRelay() {
  if (relay) relay.stop();
  relay = null;
  const { enabled, server, topic, key } = config.cloud || {};
  if (!enabled || !topic || !key) return;
  const stored = loadCloudSessions();
  tracker.seed(stored.sessions.map((s) => ({ ...s, source: 'cloud' })));
  for (const s of stored.sessions) if (Array.isArray(s.messages) && !cloudLogs.has(s.id)) cloudLogs.set(s.id, s.messages);
  relay = new RelayListener({ server, topic, key, lastId: stored.lastId });
  relay.on('event', (event) => {
    // the list shows a preview; the whole text is kept for the conversation view
    const preview =
      typeof event.message === 'string' && event.message.length > 4000 ? `${event.message.slice(0, 3999)}…` : event.message;
    tracker.handle({ ...event, message: preview, source: 'cloud' });
    appendCloudLog(event);
    linkCloudTask(event);
    saveCloudSoon();
  });
  relay.start();
}

function cloudStatus() {
  const { enabled, server, topic } = config.cloud || {};
  return { cloud: { enabled: Boolean(enabled), server, topic, connection: relay ? relay.status : 'stopped' } };
}

function updateCloud(patch) {
  const allowed = ['enabled', 'server', 'topic', 'key'];
  const changes = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  persist({ cloud: { ...config.cloud, ...changes } });
  startRelay();
  return cloudStatus();
}

// ---------------------------------------------------------------- start at sign-in

const autostartOptions = () => ({ electron: process.execPath, appRoot: APP_ROOT });

function readAutostart() {
  try {
    startsAtLogin = autostart.isEnabled(autostartOptions());
  } catch {
    startsAtLogin = false;
  }
  return { autostart: startsAtLogin };
}

function setAutostart(on) {
  try {
    if (on) autostart.enable(autostartOptions());
    else autostart.disable(autostartOptions());
  } catch (err) {
    console.error('[claude-pet] autostart:', err.message);
  }
  const result = readAutostart();
  updateTray();
  return result;
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
  const name = pet ? `${pet.displayName} — ` : '';
  tray.setToolTip(`Claude Pet — ${name}${t(`status.${agg.status}`)}${attention ? ` (${attention})` : ''}`);
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
      const p = choosePet(String(value || ''));
      if (!p) throw Object.assign(new Error('pet not found'), { status: 404 });
      return { pet: p.key };
    }
    case 'next': {
      const p = rotateNow();
      return { pet: p ? p.key : null, petName: p ? p.displayName : null };
    }
    case 'rotation':
      return value && typeof value === 'object' ? updateRotation(value) : rotationStatus();
    case 'autostart':
      return typeof value === 'boolean' ? setAutostart(value) : readAutostart();
    case 'cloud':
      return value && typeof value === 'object' ? updateCloud(value) : cloudStatus();
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

  // a link in one of Claude's replies: web pages only
  ipcMain.on('open-link', (_e, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.toString());
    } catch {
      // not a URL
    }
  });

  ipcMain.on('open-url', (_e, url, inApp) => {
    // only conversations on claude.ai: cloud sessions and browser chats
    if (typeof url !== 'string' || !/^https:\/\/claude\.ai\/[\w/.?=&-]*$/.test(url)) return;
    if (!inApp) return void shell.openExternal(url);
    // the desktop app opens claude.ai pages from claude://claude.ai/<path>, as Claude Code does
    shell.openExternal(url.replace(/^https:\/\//, 'claude://')).catch(() => shell.openExternal(url));
  });

  ipcMain.handle('open-desktop', async (_e, { sessionId }) => {
    try {
      await openInApp(sessionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // a past conversation, to continue it in the quick chat
  ipcMain.handle('open-chat', (_e, sessionId) => {
    // a cloud session: what the relay carried, and its claude.ai session to send follow-ups to
    const cloud = tracker.list().find((s) => s.id === sessionId && s.source === 'cloud');
    if (cloud) {
      const cloudId = cloudIdOf(cloud.url);
      if (!cloudId) return { ok: false, error: t('ui.chatNotFound') };
      const fallback = [
        ...(cloud.prompt ? [{ role: 'user', text: cloud.prompt }] : []),
        ...(cloud.message ? [{ role: 'assistant', text: cloud.message }] : []),
      ];
      const log = cloudLogs.get(sessionId);
      return { ok: true, cloud: true, cloudId, url: cloud.url, messages: log && log.length ? log : fallback };
    }
    const file = findTranscript(String(sessionId || ''));
    if (!file) return { ok: false, error: t('ui.chatNotFound') };
    return { ok: true, sessionId, ...readConversation(file) };
  });

  ipcMain.handle('open-terminal', async (_e, { sessionId, cwd, cloudId }) => {
    try {
      // a cloud task attaches to its cloud session interactively
      const args = CLOUD_ID.test(String(cloudId || ''))
        ? ['--cloud', cloudId]
        : [...(sessionId ? ['--resume', sessionId] : []), ...terminalModelArgs()];
      await openInTerminal({ sessionId, cwd, claudePath: claudeCommand(), template: config.terminalCommand, args });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('quick-send', (_e, { prompt, cwd, resume, cloud, files }) => {
    try {
      const { cwd: used } = quickChat.send({ prompt, cwd, resume, cloud: Boolean(cloud), files });
      persist({ quickChat: { ...config.quickChat, cwd: used, recent: remember(config.quickChat.recent, used) } });
      return { ok: true, cwd: used };
    } catch (err) {
      return { ok: false, error: err.code === 'CLAUDE_NOT_FOUND' ? t('error.claudeNotFound') : err.message };
    }
  });
  ipcMain.on('quick-stop', () => quickChat.stop());

  ipcMain.handle('choose-files', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });

  // an image pasted into the input: kept as a file Claude Code can read
  ipcMain.handle('save-pasted', (_e, data, type) => {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
    if (!ext || !(data instanceof Uint8Array) || data.length > 20 * 1024 * 1024) return null;
    const dir = path.join(homeDir(), 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
    fs.writeFileSync(file, data);
    return file;
  });

  ipcMain.handle('choose-folder', async (_e, current) => {
    const result = await dialog.showOpenDialog(win, {
      defaultPath: current || app.getPath('home'),
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    persist({ quickChat: { ...config.quickChat, recent: remember(config.quickChat.recent, result.filePaths[0]) } });
    return result.filePaths[0];
  });

  // where the quick chat works: a recent folder, another folder, or a GitHub repository
  ipcMain.handle(
    'folder-menu',
    (_e, current) =>
      new Promise((resolve) => {
        let picked = null;
        const recent = (config.quickChat.recent || []).filter((d) => fs.existsSync(d));
        const menu = Menu.buildFromTemplate([
          ...recent.map((dir) => ({
            label: dir,
            type: 'radio',
            checked: dir === current,
            click: () => (picked = { dir }),
          })),
          ...(recent.length ? [{ type: 'separator' }] : []),
          { label: t('menu.folder.choose'), click: () => (picked = { choose: true }) },
          { label: t('menu.folder.github'), click: () => (picked = { clone: true }) },
        ]);
        // the click handler runs before the menu-closed callback
        menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
      }),
  );

  // your GitHub repositories to pick from (kept for ten minutes)
  let repoCache = null;
  ipcMain.handle('list-repos', async () => {
    try {
      if (!repoCache || Date.now() - repoCache.at > 10 * 60e3) repoCache = { at: Date.now(), ...(await listGitHubRepos()) };
      return { ok: true, repos: repoCache.repos.map((r) => ({ ...r, cloned: isCloned(r.fullName) })) };
    } catch (err) {
      repoCache = null;
      return { ok: false, error: err.code === 'NO_GITHUB' ? t('error.noGitHub') : err.message };
    }
  });

  ipcMain.handle('clone-repo', async (_e, text) => {
    try {
      const { dir } = await cloneRepo(text);
      persist({ quickChat: { ...config.quickChat, cwd: dir, recent: remember(config.quickChat.recent, dir) } });
      return { ok: true, dir };
    } catch (err) {
      const known = { BAD_REPO: 'error.badRepo', NO_GIT: 'error.noGit' }[err.code];
      return { ok: false, error: known ? t(known) : err.message };
    }
  });

  ipcMain.on('quick-target', (_e, target) => {
    if (['local', 'cloud', 'chat'].includes(target)) persist({ quickChat: { ...config.quickChat, target } });
  });

  // a normal chat: a new conversation in the Claude app, asking the question
  ipcMain.handle('ask-in-app', async (_e, prompt) => {
    const q = encodeURIComponent(String(prompt || '').slice(0, 4000));
    try {
      await shell.openExternal(`claude://claude.ai/new?q=${q}`);
      return { ok: true };
    } catch {
      // no desktop app: the same page in the browser
      await shell.openExternal(`https://claude.ai/new?q=${q}`).catch(() => {});
      return { ok: true, browser: true };
    }
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
      build: buildId(),
      onEvent: (event, { fromExtension } = {}) => {
        if (!event || typeof event !== 'object') return;
        // a browser extension only reports claude.ai chats; it never tells where claude is
        if (fromExtension) tracker.handle({ ...event, claude_path: undefined, source: 'browser' });
        else {
          learnClaudePath(event.claude_path);
          tracker.handle(event);
        }
      },
      onControl: handleControl,
      getStatus: () => ({ visible: Boolean(win && win.isVisible()), sessions: tracker.list(), aggregate: tracker.aggregate() }),
    });
  } catch (err) {
    dialog.showErrorBox('Claude Pet', `ポート ${getPort()} を使えませんでした: ${err.message}`);
    app.exit(1);
    return;
  }

  pet = findPet(config.pet);
  if (config.rotation.enabled && !rotationCandidates().includes(pet && pet.key)) rotateNow();
  else checkRotation();
  // Checked often so the switch happens on time even after the computer wakes from sleep.
  setInterval(checkRotation, 30e3).unref();
  readAutostart();
  tracker.on('change', pushState);
  tracker.on('change', () => relay && saveCloudSoon()); // e.g. a cloud session removed from the list
  // Past Claude Code conversations, so the list isn't empty before the first hook event.
  const loadHistory = () => {
    try {
      tracker.seed(recentSessions());
    } catch {
      // unreadable transcripts shouldn't stop the pet
    }
  };
  loadHistory();
  setInterval(loadHistory, 10 * 60e3).unref();
  startRelay();
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
    clearTimeout(saveTimer);
    saveConfig(config);
  });
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    // Linux compositors need a moment before transparent windows render correctly.
    setTimeout(boot, process.platform === 'linux' ? 300 : 0);
  });
}
