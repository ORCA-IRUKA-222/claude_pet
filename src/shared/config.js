'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PORT = 47717;

function homeDir() {
  return process.env.CLAUDE_PET_HOME || path.join(os.homedir(), '.claude-pet');
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const DEFAULTS = {
  pet: 'mochi',
  scale: 0.5, // 0.5 / 0.75 / 1.0 of a 192x208 cell
  mini: false,
  visible: true,
  alwaysOnTop: true,
  showBubble: true,
  notifications: false,
  language: 'ja',
  position: null, // { x, y } of the window's top-left corner
  shortcuts: {
    toggle: 'CommandOrControl+Alt+P',
    quickChat: 'CommandOrControl+Alt+C',
    screenshot: 'CommandOrControl+Alt+S',
  },
  quickChat: {
    cwd: null, // defaults to the home directory
    permissionMode: 'default',
    model: 'claude-opus-5-5', // see MODELS in src/electron/main.js
    effort: 'xhigh', // low | medium | high | xhigh | max
    openInApp: false, // also open each new quick chat in the Claude desktop app
    target: 'local', // local: Claude Code here, cloud: a cloud session, chat: a normal chat in the app
    recent: [], // recently used folders
  },
  rotation: {
    enabled: false,
    intervalMinutes: 60,
    group: null, // rotate among pets whose pet.json has this "group"
    pets: [], // or an explicit list of pet ids; both empty = every pet
    order: 'shuffle', // 'shuffle' | 'sequence'
    lastChangedAt: 0,
    queue: [],
  },
  claudePath: null, // defaults to `claude` on PATH or in the usual install folders
  learnedClaudePath: null, // where Claude Code ran from, as reported by the hook
  cloud: {
    enabled: false, // show cloud sessions, relayed through an ntfy topic (claude-pet cloud setup)
    server: 'https://ntfy.sh',
    topic: null,
    key: null,
  },
  terminalCommand: null, // e.g. "wezterm start --cwd {cwd} -- {command}"
  editorCommand: null, // e.g. "code -g {file}"; defaults to VS Code / Cursor if found, else the file manager
  staleMinutes: 30,
  permissionPrompt: {
    enabled: true, // answer Claude Code's permission prompts from the pet
    timeoutSeconds: 120, // after this the prompt is left to the terminal
  },
  pomodoro: {
    focusMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    longBreakEvery: 4,
    autoStart: true,
  },
  calendar: {
    url: null, // an iCal (.ics) URL, e.g. Google Calendar's secret address in iCal format
    remindMinutes: 5,
    refreshMinutes: 15,
  },
  dnd: { active: false, until: null, allowWaiting: true },
  awayMinutes: 5,
  greetings: true, // greetings by time of day, battery and sleep
};

const PERMISSION_TIMEOUT_MAX = 600;

function permissionTimeoutMs(config) {
  const seconds = Number(config && config.permissionPrompt && config.permissionPrompt.timeoutSeconds);
  const valid = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULTS.permissionPrompt.timeoutSeconds;
  return Math.min(valid, PERMISSION_TIMEOUT_MAX) * 1000;
}

function configPath() {
  return path.join(homeDir(), 'config.json');
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function loadConfig() {
  return merge(DEFAULTS, readJSON(configPath(), {}));
}

function saveConfig(config) {
  fs.mkdirSync(homeDir(), { recursive: true });
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, configPath());
}

function getPort() {
  const fromEnv = Number(process.env.CLAUDE_PET_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const fromFile = Number(readJSON(configPath(), {}).port);
  return Number.isInteger(fromFile) && fromFile > 0 ? fromFile : DEFAULT_PORT;
}

// A random secret shared by the pet and its hooks (see core/permissions.js).
function secretPath() {
  return path.join(homeDir(), 'secret');
}

function readSecret() {
  try {
    const secret = fs.readFileSync(secretPath(), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

function ensureSecret() {
  const existing = readSecret();
  if (existing) return existing;
  fs.mkdirSync(homeDir(), { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath(), secret + '\n', { mode: 0o600 });
  return secret;
}

module.exports = {
  APP_ROOT,
  DEFAULTS,
  DEFAULT_PORT,
  PERMISSION_TIMEOUT_MAX,
  homeDir,
  claudeDir,
  configPath,
  loadConfig,
  saveConfig,
  getPort,
  merge,
  readJSON,
  permissionTimeoutMs,
  secretPath,
  readSecret,
  ensureSecret,
};
