'use strict';

// Open a file Claude changed. Uses `editorCommand` from the config when set,
// otherwise VS Code or Cursor if their command is on PATH. Without an editor
// the caller shows the file in the file manager instead: opening it with the
// system default could *run* it (a .js or .bat file on Windows, for example).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { cleanEnv } = require('../shared/env');
const { shellQuote } = require('./terminal');

const EDITORS = ['code', 'cursor', 'codium'];

function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const dirs = String(env.PATH || env.Path || '')
    .split(path.delimiter)
    .filter(Boolean);
  const names = platform === 'win32' ? [`${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return null;
}

let detected;
function detectEditor() {
  if (detected === undefined) detected = EDITORS.map((name) => findOnPath(name)).find(Boolean) || null;
  return detected;
}

function launch(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: cleanEnv(), windowsHide: true, ...options });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

// cmd.exe expands these even inside double quotes.
const CMD_UNSAFE = /["%!^&|<>\r\n]/;

/**
 * The file name comes from the repository Claude worked in, so it must not be
 * able to run anything when it is put on a shell command line.
 */
function quoteForShell(file, platform = process.platform) {
  if (platform === 'win32') {
    if (CMD_UNSAFE.test(file)) throw new Error('unsafe file name');
    return `"${file}"`;
  }
  return shellQuote(file);
}

/**
 * @returns {Promise<boolean>} false when no editor is available (show the file in its folder instead)
 */
async function openInEditor(file, { template = null } = {}) {
  if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error('file not found');
  if (template) {
    return launch(template.replaceAll('{file}', quoteForShell(file)), [], { shell: true, cwd: path.dirname(file) });
  }
  const editor = detectEditor();
  if (!editor) return false;
  // `code.cmd` needs a shell on Windows.
  if (process.platform === 'win32') return launch(`"${editor}"`, ['-g', quoteForShell(file)], { shell: true });
  return launch(editor, ['-g', file]);
}

module.exports = { openInEditor, findOnPath, detectEditor, quoteForShell };
