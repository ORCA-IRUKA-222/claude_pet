'use strict';

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
  staleMinutes: 30,
};

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

module.exports = {
  APP_ROOT,
  DEFAULTS,
  DEFAULT_PORT,
  homeDir,
  claudeDir,
  configPath,
  loadConfig,
  saveConfig,
  getPort,
  merge,
  readJSON,
};
