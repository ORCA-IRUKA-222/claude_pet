'use strict';

// Finds the `claude` executable. The pet often starts outside a shell (at sign-in or from
// a shortcut) where PATH may not include it, so the hook also reports where Claude Code
// runs from (CLAUDE_CODE_EXECPATH), and the usual install folders and the copies bundled
// with the editor extensions and the desktop app are checked.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXECUTABLE = /^claude(\.exe|\.cmd)?$/i;

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const newestFirst = (names) => names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

/** Copies of Claude Code that editors and the desktop app keep for themselves, newest first. */
function bundled({ platform, env, home, list = listDir }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';
  const out = [];
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = p.join(home, editor, 'extensions');
    for (const name of newestFirst(list(dir).filter((n) => n.startsWith('anthropic.claude-code-')))) {
      out.push(p.join(dir, name, 'resources', 'native-binary', exe));
    }
  }
  const desktop =
    platform === 'win32'
      ? p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code')
      : platform === 'darwin'
        ? p.join(home, 'Library', 'Application Support', 'Claude', 'claude-code')
        : null;
  if (desktop) for (const version of newestFirst(list(desktop))) out.push(p.join(desktop, version, exe));
  return out;
}

function candidates({ platform, env, home, list }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = String(env.PATH || env.Path || '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean);
  if (platform === 'win32') {
    const appData = env.APPDATA || p.join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    dirs.push(p.join(home, '.local', 'bin'), p.join(appData, 'npm'), p.join(localAppData, 'Microsoft', 'WinGet', 'Links'));
  } else {
    dirs.push(
      p.join(home, '.local', 'bin'),
      p.join(home, '.claude', 'local'),
      p.join(home, '.npm-global', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    );
  }
  return [...dirs.flatMap((dir) => names.map((name) => p.join(dir, name))), ...bundled({ platform, env, home, list })];
}

const versions = new Map(); // path → { mtimeMs, version }

/** "2.1.310" for a claude executable, or null; cached until the file changes. */
function claudeVersion(file) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const cached = versions.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  let version = null;
  try {
    const cmd = process.platform === 'win32' && !/\.exe$/i.test(file);
    const out = execFileSync(cmd ? `"${file}"` : file, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      shell: cmd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    version = (/\d+\.\d+\.\d+/.exec(out) || [])[0] || null;
  } catch {
    // not runnable
  }
  versions.set(file, { mtimeMs, version });
  return version;
}

function compareVersions(a, b) {
  const pa = String(a || '0')
    .split('.')
    .map(Number);
  const pb = String(b || '0')
    .split('.')
    .map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Every claude found, with its version, in search order. */
function allClaudes({
  learned,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  exists = isFile,
  list = listDir,
  versionOf = claudeVersion,
} = {}) {
  const seen = new Set();
  const out = [];
  for (const file of [learned, ...candidates({ platform, env, home, list })]) {
    if (!file || seen.has(file.toLowerCase()) || !exists(file)) continue;
    seen.add(file.toLowerCase());
    out.push({ path: file, version: versionOf(file) });
  }
  return out;
}

/**
 * The claude command to run, or null when none was found. Several copies are common (the
 * terminal install, the ones inside VS Code and the desktop app), and older ones lack
 * features the pet uses, so the newest version wins.
 * @param {object} opts
 * @param {string} [opts.configured] `claudePath` from the config, used as is
 * @param {string} [opts.learned]    path a hook reported earlier
 */
function findClaude({ configured, ...opts } = {}) {
  if (configured) return configured;
  const found = allClaudes(opts);
  if (!found.length) return null;
  return found.reduce((best, c) => (compareVersions(c.version, best.version) > 0 ? c : best)).path;
}

/** Whether a path reported by a hook looks like Claude Code's own executable. */
function isClaudeExecutable(file) {
  return typeof file === 'string' && path.isAbsolute(file) && EXECUTABLE.test(path.basename(file)) && isFile(file);
}

module.exports = { findClaude, allClaudes, claudeVersion, compareVersions, isClaudeExecutable, candidates };
