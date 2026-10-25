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
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  powerMonitor,
  screen,
  shell,
  systemPreferences,
} = require('electron');

const { APP_ROOT, getPort, homeDir, loadConfig, saveConfig, ensureSecret, permissionTimeoutMs } = require('../shared/config');
const { translator } = require('../shared/i18n');
const { SessionTracker } = require('../core/sessions');
const { startServer } = require('../core/server');
const { listPets, findPet } = require('../core/pets');
const { QuickChat, validAttachments, withAttachments } = require('../core/quickchat');
const { openInTerminal } = require('../core/terminal');
const { openInEditor } = require('../core/editor');
const { TimeKeeper } = require('../core/timers');
const { Modes } = require('../core/modes');
const { MemoStore } = require('../core/memos');
const { CalendarFeed } = require('../core/calendar');
const { PermissionBroker } = require('../core/permissions');
const { requestPause, cancelPause } = require('../shared/pause');
const installer = require('../core/installer');
const { version } = require('../../package.json');

const SCALES = { small: 0.5, medium: 0.75, large: 1 };
const DND_MINUTES = [30, 60, 120];
const TURN_OVER = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']);
const MAX_SCREENSHOTS = 20;

const config = loadConfig();
let t = translator(config.language);
let win = null;
let tray = null;
let pet = null;
let anchor = null; // bottom-centre of the pet, in screen coordinates
let drag = null;
let saveTimer = null;
let quitting = false;
let awayCause = null; // 'idle' | 'lock' | 'sleep'
const power = { locked: false, suspended: false };

const tracker = new SessionTracker({ staleMs: config.staleMinutes * 60e3 });
const quickChat = new QuickChat({
  claudePath: config.claudePath,
  permissionMode: config.quickChat.permissionMode,
  model: config.quickChat.model,
});
quickChat.on('event', (ev) => sendToRenderer('quick-event', ev));

const timeKeeper = new TimeKeeper({ pomodoro: config.pomodoro });
const modes = new Modes({ dnd: config.dnd });
const memos = new MemoStore();
const calendar = new CalendarFeed({ fetch: (url, init) => net.fetch(url, init) });
const permissions = new PermissionBroker({ timeoutMs: permissionTimeoutMs(config) });

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
    greetings: config.greetings !== false,
    permissionPrompt: config.permissionPrompt.enabled !== false,
  };
}

function appState() {
  return { sessions: tracker.list(), aggregate: tracker.aggregate(), permissions: permissions.list(), modes: modes.snapshot() };
}

function pushState() {
  sendToRenderer('state', appState());
  updateTray();
}

function pushTimers() {
  sendToRenderer('timers', timeKeeper.snapshot());
}

function pushMemos() {
  sendToRenderer('memos', memos.list());
}

function pushCalendar() {
  sendToRenderer('calendar', calendar.snapshot());
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
    acceptFirstMouse: true, // macOS: the first click on the unfocused pet (e.g. 許可) should count
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

// ---------------------------------------------------------------- おやすみモード

function clockText(ts) {
  return new Date(ts).toLocaleTimeString(config.language === 'en' ? 'en-US' : 'ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function dndUntilText() {
  const dnd = modes.snapshot().dnd;
  if (!dnd) return '';
  return dnd.until == null ? t('cli.dndForever') : t('cli.dndUntil', { time: clockText(dnd.until) });
}

/** minutes: a number, or null for "until turned off". */
function setDnd(minutes) {
  modes.setDnd({ until: minutes ? Date.now() + minutes * 60e3 : null, allowWaiting: config.dnd.allowWaiting !== false });
}

function saveDnd() {
  const dnd = modes.snapshot().dnd;
  persist({
    dnd: {
      active: Boolean(dnd),
      until: dnd ? dnd.until : null,
      allowWaiting: dnd ? dnd.allowWaiting : config.dnd.allowWaiting !== false,
    },
  });
}

// ---------------------------------------------------------------- menus

function buildMenu() {
  const pets = listPets();
  const scaleKey = Object.keys(SCALES).find((k) => SCALES[k] === config.scale) || 'small';
  const visible = Boolean(win && win.isVisible());
  const dnd = modes.snapshot().dnd;
  return Menu.buildFromTemplate([
    { label: t('menu.sessions'), click: () => openPanel('sessions') },
    { label: t('menu.quickChat'), accelerator: config.shortcuts.quickChat || undefined, click: () => openQuickChat() },
    { label: t('menu.screenshot'), accelerator: config.shortcuts.screenshot || undefined, click: () => askAboutScreenshot() },
    { label: t('menu.tools'), click: () => openPanel('timer') },
    { type: 'separator' },
    {
      label: dnd ? t('menu.dndActive', { until: dndUntilText() }) : t('menu.dnd'),
      submenu: [
        ...DND_MINUTES.map((m) => ({ label: t(`menu.dnd.${m}`), click: () => setDnd(m) })),
        { label: t('menu.dnd.forever'), click: () => setDnd(null) },
        { type: 'separator' },
        {
          label: t('menu.dnd.allowWaiting'),
          type: 'checkbox',
          checked: dnd ? dnd.allowWaiting : config.dnd.allowWaiting !== false,
          click: (item) => {
            persist({ dnd: { ...config.dnd, allowWaiting: item.checked } });
            modes.setDndAllowWaiting(item.checked);
            saveDnd();
          },
        },
        { label: t('menu.dnd.off'), enabled: Boolean(dnd), click: () => modes.clearDnd() },
      ],
    },
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
      label: t('menu.permissionPrompt'),
      type: 'checkbox',
      checked: config.permissionPrompt.enabled !== false,
      click: (item) => {
        persist({ permissionPrompt: { ...config.permissionPrompt, enabled: item.checked } });
        if (!item.checked) permissions.cancelAll();
        sendToRenderer('config', rendererConfig());
      },
    },
    {
      label: t('menu.greetings'),
      type: 'checkbox',
      checked: config.greetings !== false,
      click: (item) => {
        persist({ greetings: item.checked });
        sendToRenderer('config', rendererConfig());
      },
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
  const mode = modes.snapshot();
  const modeText = mode.dnd ? ` · ${t('mode.dnd')}` : mode.focus ? ` · ${t('mode.focus')}` : '';
  tray.setToolTip(`Claude Pet — ${t(`status.${agg.status}`)}${attention ? ` (${attention})` : ''}${modeText}`);
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

function notify(title, body = '', { silent = false } = {}) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body: String(body).slice(0, 200), silent }).show();
}

function notifyTransition({ session, to }) {
  const attention =
    ['waiting', 'ready', 'failed'].includes(to) && session.source !== 'quickchat' && (to !== 'ready' || session.unread);
  if (attention) modes.record(to);
  const held = attention && modes.holds(to);
  sendToRenderer('transition', { session, to, held });
  if (!attention || held || !config.notifications) return;
  const body = to === 'ready' ? session.message || '' : session.detail || session.message || '';
  notify(t(`notify.${to}`, { project: session.title || session.project }), body, { silent: to === 'ready' });
}

// ---------------------------------------------------------------- hook events

function handleEvent(event) {
  if (!event || typeof event !== 'object') return;
  permissions.observe(event);
  // A pause that never reached a tool call shouldn't stop the next turn.
  if (TURN_OVER.has(event.event) && typeof event.session_id === 'string') cancelPause(event.session_id);
  tracker.handle(event);
}

function handlePermission(event, options) {
  if (config.permissionPrompt.enabled === false) return null;
  return permissions.request(event, options);
}

// ---------------------------------------------------------------- away / power

function checkAway() {
  let idle = 0;
  try {
    idle = powerMonitor.getSystemIdleTime();
  } catch {
    idle = 0;
  }
  const minutes = Number(config.awayMinutes) > 0 ? Number(config.awayMinutes) : 5;
  const cause = power.suspended ? 'sleep' : power.locked ? 'lock' : idle >= minutes * 60 ? 'idle' : null;
  // Remember why the user left; going to sleep while already away still counts as sleep.
  if (cause && (!modes.away || cause === 'sleep')) awayCause = cause;
  modes.setAway(Boolean(cause));
}

function watchPower() {
  powerMonitor.on('lock-screen', () => {
    power.locked = true;
    checkAway();
  });
  powerMonitor.on('unlock-screen', () => {
    power.locked = false;
    checkAway();
  });
  powerMonitor.on('suspend', () => {
    power.suspended = true;
    checkAway();
  });
  powerMonitor.on('resume', () => {
    power.suspended = false;
    checkAway();
    refreshCalendar();
  });
  setInterval(checkAway, 15e3).unref();
}

// ---------------------------------------------------------------- timers

function wireTimers() {
  timeKeeper.on('change', () => {
    modes.setFocus(timeKeeper.isFocusing());
    pushTimers();
  });
  timeKeeper.on('timer-done', ({ label }) => {
    if (win && !win.isVisible()) setVisible(true);
    sendToRenderer('alarm', { kind: 'timer', label });
    notify(t('notify.timer'), label || '');
  });
  timeKeeper.on('pomodoro-phase', ({ from, to }) => {
    const minutes = to ? Math.round(timeKeeper.phaseLength(to) / 60e3) : 0;
    sendToRenderer('alarm', { kind: 'pomodoro', from, to, minutes });
    if (from === 'focus' && to) notify(t('notify.pomoBreak', { min: minutes }));
    else if (from && to === 'focus') notify(t('notify.pomoFocus', { min: minutes }));
  });
}

function timerCommand(action, value = {}) {
  switch (action) {
    case 'start':
      return timeKeeper.startTimer(value.ms, value.label);
    case 'pause':
      return timeKeeper.pauseTimer();
    case 'resume':
      return timeKeeper.resumeTimer();
    case 'reset':
      return timeKeeper.resetTimer();
    case 'sw-start':
      return timeKeeper.startStopwatch();
    case 'sw-pause':
      return timeKeeper.pauseStopwatch();
    case 'sw-reset':
      return timeKeeper.resetStopwatch();
    case 'pomo-start':
      return timeKeeper.startPomodoro();
    case 'pomo-pause':
      return timeKeeper.pausePomodoro();
    case 'pomo-skip':
      return timeKeeper.skipPomodoro();
    case 'pomo-stop':
      return timeKeeper.stopPomodoro();
    default:
      throw new Error(`unknown timer action: ${action}`);
  }
}

// ---------------------------------------------------------------- calendar

let calendarTimer = null;

async function refreshCalendar() {
  if (!calendar.url) return;
  pushCalendar();
  await calendar.refresh();
  pushCalendar();
}

function scheduleCalendar() {
  clearInterval(calendarTimer);
  const minutes = Math.max(5, Number(config.calendar.refreshMinutes) || 15);
  calendarTimer = setInterval(refreshCalendar, minutes * 60e3);
  calendarTimer.unref();
}

function checkReminders() {
  if (!calendar.url || modes.snapshot().dnd) return;
  const minutes = Math.max(1, Number(config.calendar.remindMinutes) || 5);
  for (const event of calendar.dueReminders(minutes)) {
    const min = Math.max(1, Math.round((event.start - Date.now()) / 60e3));
    sendToRenderer('alarm', { kind: 'calendar', title: event.summary, start: event.start, minutes: min });
    notify(t('cal.reminder', { min, title: event.summary || t('cal.untitled') }), event.location || '');
  }
}

async function setCalendarUrl(url) {
  calendar.setUrl(url || null); // throws on an invalid URL
  persist({ calendar: { ...config.calendar, url: calendar.url } });
  pushCalendar();
  await refreshCalendar();
  return calendar.snapshot();
}

// ---------------------------------------------------------------- screenshot

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pruneScreenshots(dir) {
  const shots = fs
    .readdirSync(dir)
    .filter((f) => /^shot-.*\.png$/.test(f))
    .sort();
  for (const old of shots.slice(0, Math.max(0, shots.length - MAX_SCREENSHOTS))) fs.rmSync(path.join(dir, old), { force: true });
}

/** Capture the display under the cursor (with the pet hidden) and save it as a PNG. */
async function captureScreen() {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
    throw Object.assign(new Error('permission'), { code: 'permission' });
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wasVisible = Boolean(win && win.isVisible());
  if (wasVisible) win.hide();
  try {
    await new Promise((r) => setTimeout(r, 250));
    const size = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw Object.assign(new Error('no image'), { code: 'permission' });
    const dir = path.join(homeDir(), 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${stamp()}.png`);
    fs.writeFileSync(file, source.thumbnail.toPNG());
    pruneScreenshots(dir);
    return file;
  } finally {
    if (wasVisible) win.showInactive();
  }
}

async function askAboutScreenshot() {
  try {
    const file = await captureScreen();
    openQuickChat();
    sendToRenderer('attach', { files: [file], kind: 'screenshot' });
    return { file };
  } catch (err) {
    setVisible(true);
    sendToRenderer('say', {
      text:
        err.code === 'permission' && process.platform === 'darwin'
          ? t('say.shotPermission')
          : t('say.shotFailed', { error: err.message }),
    });
    return { error: err.message };
  }
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
    case 'timer': {
      const { command, ...rest } = value || {};
      try {
        timerCommand(String(command || ''), rest);
      } catch (err) {
        throw Object.assign(err, { status: 400 });
      }
      if (command === 'start' || command === 'pomo-start') setVisible(true);
      return { timers: timeKeeper.snapshot() };
    }
    case 'memo-add': {
      const memo = memos.add({ text: value && value.text, cwd: value && value.cwd });
      pushMemos();
      return { memo };
    }
    case 'dnd': {
      if (value && value.off) modes.clearDnd();
      else setDnd(value && Number(value.minutes) > 0 ? Number(value.minutes) : null);
      return { dnd: modes.snapshot().dnd, until: dndUntilText() };
    }
    case 'screenshot':
      return askAboutScreenshot();
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
    state: appState(),
    timers: timeKeeper.snapshot(),
    memos: memos.list(),
    calendar: calendar.snapshot(),
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
  ipcMain.on('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('open-terminal', async (_e, { sessionId, cwd }) => {
    try {
      await openInTerminal({ sessionId, cwd, claudePath: config.claudePath, template: config.terminalCommand });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('quick-send', (_e, { prompt, cwd, resume, attachments }) => {
    try {
      const files = validAttachments(attachments);
      const { prompt: full, addDirs } = withAttachments(String(prompt || ''), files, t('ui.attachedFiles'));
      const { cwd: used } = quickChat.send({ prompt: full, cwd, resume, addDirs });
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

  // Claude Code sessions
  ipcMain.on('permission-answer', (_e, { id, behavior }) => permissions.answer(String(id), behavior));
  ipcMain.on('pause-session', (_e, id) => {
    if (requestPause(String(id))) tracker.setPauseRequested(String(id), true);
  });
  ipcMain.on('cancel-pause', (_e, id) => {
    cancelPause(String(id));
    tracker.setPauseRequested(String(id), false);
  });
  ipcMain.handle('open-file', async (_e, { sessionId, file, reveal }) => {
    // Only files Claude changed in that session, so the renderer can't open arbitrary paths.
    if (!tracker.hasFile(String(sessionId), String(file)) || !fs.existsSync(file)) return { ok: false };
    try {
      if (!reveal && (await openInEditor(file, { template: config.editorCommand }))) return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
    shell.showItemInFolder(file);
    return { ok: true, revealed: true };
  });

  // Tools
  ipcMain.handle('timer', (_e, { action, value }) => {
    try {
      timerCommand(String(action), value || {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('memo', (_e, { action, id, text, cwd, changes }) => {
    try {
      if (action === 'add') memos.add({ text, cwd });
      else if (action === 'update') memos.update(String(id), changes || {});
      else if (action === 'remove') memos.remove(String(id));
      else if (action === 'clear-done') memos.clearDone();
      pushMemos();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('calendar-set-url', async (_e, url) => {
    try {
      return { ok: true, calendar: await setCalendarUrl(url) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.on('calendar-refresh', () => refreshCalendar());
  ipcMain.handle('screenshot', () => askAboutScreenshot());
}

// ---------------------------------------------------------------- lifecycle

function registerShortcuts() {
  const { toggle, quickChat: chat, screenshot: shot } = config.shortcuts || {};
  for (const [accelerator, action] of [
    [toggle, () => setVisible(!(win && win.isVisible()))],
    [chat, () => openQuickChat()],
    [shot, () => askAboutScreenshot()],
  ]) {
    if (!accelerator) continue;
    try {
      globalShortcut.register(accelerator, action);
    } catch {
      // An invalid or already-taken accelerator shouldn't stop the app.
    }
  }
}

function quit() {
  quitting = true;
  clearTimeout(saveTimer);
  permissions.cancelAll();
  saveConfig(config);
  app.quit();
}

async function boot() {
  let secret = null;
  try {
    secret = ensureSecret();
  } catch {
    secret = null; // without it, permission prompts simply stay in the terminal
  }
  try {
    await startServer({
      port: getPort(),
      version,
      secret,
      onEvent: handleEvent,
      onPermission: handlePermission,
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
  permissions.on('change', pushState);
  modes.on('change', () => {
    saveDnd();
    pushState();
  });
  modes.on('digest', (digest) => {
    sendToRenderer('digest', { ...digest, cause: digest.reason === 'away' ? awayCause : null });
    if (digest.reason === 'away') awayCause = null;
  });
  setInterval(() => tracker.prune(), 60e3).unref();
  wireTimers();

  try {
    calendar.setUrl(config.calendar.url);
  } catch {
    calendar.setUrl(null);
  }
  scheduleCalendar();
  setInterval(checkReminders, 30e3).unref();

  registerIpc();
  createWindow();
  createTray();
  registerShortcuts();
  watchPower();
  refreshCalendar();
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
    permissions.cancelAll();
  });
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    // Linux compositors need a moment before transparent windows render correctly.
    setTimeout(boot, process.platform === 'linux' ? 300 : 0);
  });
}
