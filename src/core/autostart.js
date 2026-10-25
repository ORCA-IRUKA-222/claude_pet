'use strict';

// Starts the pet when the user signs in. Each platform launches Electron directly, so no
// terminal window opens: a value under the Run registry key on Windows, a LaunchAgent on
// macOS and an XDG autostart entry on Linux.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'ClaudePet';
const LABEL = 'dev.claude-pet';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function defaultReg(args) {
  return execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

function options(opts = {}) {
  return {
    platform: opts.platform || process.platform,
    home: opts.home || os.homedir(),
    env: opts.env || process.env,
    reg: opts.reg || defaultReg,
    electron: opts.electron,
    appRoot: opts.appRoot,
  };
}

function plistPath(o) {
  return path.join(o.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function desktopPath(o) {
  const configHome = o.env.XDG_CONFIG_HOME || path.join(o.home, '.config');
  return path.join(configHome, 'autostart', 'claude-pet.desktop');
}

function xml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plist(o) {
  // launchd starts agents with a bare PATH, so keep the one `claude` was found on.
  const pathVar = o.env.PATH
    ? `\n  <key>EnvironmentVariables</key>\n  <dict><key>PATH</key><string>${xml(o.env.PATH)}</string></dict>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(o.electron)}</string><string>${xml(o.appRoot)}</string></array>
  <key>RunAtLoad</key><true/>${pathVar}
</dict>
</plist>
`;
}

function desktopArg(text) {
  return `"${String(text).replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
}

function desktopEntry(o) {
  return `[Desktop Entry]
Type=Application
Name=Claude Pet
Exec=${desktopArg(o.electron)} ${desktopArg(o.appRoot)}
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

function runCommand(o) {
  return `"${o.electron}" "${o.appRoot}"`;
}

/** Whether the pet starts at sign-in. */
function isEnabled(opts) {
  const o = options(opts);
  if (o.platform === 'win32') {
    try {
      return o.reg(['query', RUN_KEY, '/v', NAME]).includes(NAME);
    } catch {
      return false; // reg exits non-zero when the value is missing
    }
  }
  return fs.existsSync(o.platform === 'darwin' ? plistPath(o) : desktopPath(o));
}

/** Start the pet at sign-in. `electron` and `appRoot` say what to launch. */
function enable(opts) {
  const o = options(opts);
  if (!o.electron || !o.appRoot) throw new Error('electron and appRoot are required');
  if (o.platform === 'win32') {
    o.reg(['add', RUN_KEY, '/v', NAME, '/t', 'REG_SZ', '/d', runCommand(o), '/f']);
    return RUN_KEY;
  }
  const file = o.platform === 'darwin' ? plistPath(o) : desktopPath(o);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, o.platform === 'darwin' ? plist(o) : desktopEntry(o));
  return file;
}

function disable(opts) {
  const o = options(opts);
  if (o.platform === 'win32') {
    if (isEnabled(o)) o.reg(['delete', RUN_KEY, '/v', NAME, '/f']);
    return;
  }
  fs.rmSync(o.platform === 'darwin' ? plistPath(o) : desktopPath(o), { force: true });
}

module.exports = { isEnabled, enable, disable, RUN_KEY, NAME };
