'use strict';

// Finds the `claude` executable. The pet often starts outside a shell (at sign-in or from
// a shortcut) where PATH may not include it, so the hook also reports where Claude Code
// runs from (CLAUDE_CODE_EXECPATH) and the usual install folders are checked.

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

function candidates({ platform, env, home }) {
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
  return dirs.flatMap((dir) => names.map((name) => p.join(dir, name)));
}

/**
 * The claude command to run, or null when none was found.
 * @param {object} opts
 * @param {string} [opts.configured] `claudePath` from the config, used as is
 * @param {string} [opts.learned]    path a hook reported earlier
 */
function findClaude({
  configured,
  learned,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  exists = isFile,
} = {}) {
  if (configured) return configured;
  if (learned && exists(learned)) return learned;
  return candidates({ platform, env, home }).find(exists) || null;
}

/** Whether a path reported by a hook looks like Claude Code's own executable. */
function isClaudeExecutable(file) {
  return typeof file === 'string' && path.isAbsolute(file) && EXECUTABLE.test(path.basename(file)) && isFile(file);
}

module.exports = { findClaude, isClaudeExecutable, candidates };
