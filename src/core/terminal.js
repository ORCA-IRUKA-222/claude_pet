'use strict';

// Open a terminal window that runs `claude --resume <session>` (or a new `claude`) in a folder.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { SESSION_ID } = require('./quickchat');
const { cleanEnv } = require('../shared/env');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function detached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: cleanEnv(), ...options });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function firstAvailable(candidates) {
  let lastError = null;
  for (const [command, args, options] of candidates) {
    try {
      await detached(command, args, options);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('no terminal found');
}

/**
 * @param {object} opts
 * @param {string} opts.cwd          folder to start in
 * @param {string} [opts.sessionId]  Claude Code session to resume; a new one starts without it
 * @param {string} [opts.claudePath] claude executable
 * @param {string} [opts.template]   custom command, e.g. "wezterm start --cwd {cwd} -- {command}"
 * @param {string[]} [opts.args]     claude arguments instead of `--resume <session>`
 */
async function openInTerminal({ cwd, sessionId, claudePath, template, args }) {
  if (sessionId && !SESSION_ID.test(sessionId)) throw new Error('invalid session id');
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const claude = claudePath || 'claude';
  const claudeArgs = args || (sessionId ? ['--resume', sessionId] : []);
  // session ids are plain tokens; anything else (a cloud task) is quoted for the shell
  const quoteArg = (a) => (/^[\w.:/=-]+$/.test(a) ? a : process.platform === 'win32' ? `"${a}"` : shellQuote(a));
  const claudeCommand = [/\s/.test(claude) ? `"${claude}"` : claude, ...claudeArgs.map(quoteArg)].join(' ');

  if (template) {
    const command = template.replaceAll('{cwd}', JSON.stringify(dir)).replaceAll('{command}', claudeCommand);
    return detached(command, [], { shell: true, cwd: dir });
  }

  switch (process.platform) {
    case 'darwin': {
      const script = [
        'tell application "Terminal"',
        'activate',
        `do script "cd " & quoted form of ${appleScriptString(dir)} & " && ${claudeCommand.replace(/"/g, '\\"')}"`,
        'end tell',
      ].join('\n');
      return detached('osascript', ['-e', script]);
    }
    case 'win32':
      return firstAvailable([
        // separate arguments: Windows Terminal quotes each one again for the new tab
        ['wt.exe', ['-d', dir, 'cmd.exe', '/k', claude, ...claudeArgs]],
        ['cmd.exe', ['/c', 'start', '""', '/D', `"${dir}"`, 'cmd.exe', '/k', claudeCommand], { windowsVerbatimArguments: true }],
      ]);
    default: {
      const run = `cd ${shellQuote(dir)} && ${claudeCommand}; exec "\${SHELL:-bash}"`;
      return firstAvailable([
        ['x-terminal-emulator', ['-e', 'bash', '-lc', run]],
        ['gnome-terminal', ['--', 'bash', '-lc', run]],
        ['konsole', ['-e', 'bash', '-lc', run]],
        ['xfce4-terminal', ['-x', 'bash', '-lc', run]],
        ['alacritty', ['-e', 'bash', '-lc', run]],
        ['kitty', ['bash', '-lc', run]],
        ['xterm', ['-e', 'bash', '-lc', run]],
      ]);
    }
  }
}

function powerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Start a cloud session for a task in a terminal (`claude --cloud "<task>"`), for Claude Code
 * versions that only start new cloud sessions interactively. The task is free text, so on
 * Windows it goes through PowerShell's -EncodedCommand instead of cmd.exe quoting.
 */
async function openCloudTask({ cwd, claudePath, task, extraArgs = [] }) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const claude = claudePath || 'claude';
  if (process.platform !== 'win32') {
    return openInTerminal({ cwd: dir, claudePath: claude, args: ['--cloud', String(task), ...extraArgs] });
  }
  const rest = extraArgs.map(powerShellString).join(' ');
  const script = `Set-Location -LiteralPath ${powerShellString(dir)}; & ${powerShellString(claude)} --cloud ${powerShellString(task)} ${rest}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return firstAvailable([
    ['wt.exe', ['-d', dir, 'powershell.exe', '-NoExit', '-EncodedCommand', encoded]],
    [
      'cmd.exe',
      ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-EncodedCommand', encoded],
      { windowsVerbatimArguments: true },
    ],
  ]);
}

module.exports = { openInTerminal, openCloudTask, shellQuote, appleScriptString, powerShellString };
