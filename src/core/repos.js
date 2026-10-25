'use strict';

// GitHub repositories for the quick chat to work in. A cloud task runs on the repository
// of the folder it is sent from, so a repository picked by name is cloned once into
// ~/claude-repos/<owner>/<repo> (a partial clone: history without file contents).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanEnv } = require('../shared/env');

const NAME = /^[A-Za-z0-9_.-]+$/;

/** "owner/repo", a github.com URL or an SSH remote → { owner, repo }, or null. */
function parseRepo(text) {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(text || '').trim());
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2]) || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return null;
  return { owner: m[1], repo: m[2] };
}

function reposRoot() {
  return path.join(os.homedir(), 'claude-repos');
}

/** Clone (or reuse) the repository and resolve to its folder. */
function cloneRepo(text, { root = reposRoot(), git = 'git' } = {}) {
  const parsed = parseRepo(text);
  if (!parsed) return Promise.reject(Object.assign(new Error('not a GitHub repository'), { code: 'BAD_REPO' }));
  const dest = path.join(root, parsed.owner, parsed.repo);
  if (fs.existsSync(path.join(dest, '.git'))) return Promise.resolve({ dir: dest, existed: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    // no terminal to answer a password prompt; Git Credential Manager still shows its window
    const child = spawn(git, ['clone', '--filter=blob:none', url, dest], {
      env: cleanEnv(process.env, { GIT_TERMINAL_PROMPT: '0' }),
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (err) =>
      reject(err.code === 'ENOENT' ? Object.assign(new Error('git not found'), { code: 'NO_GIT' }) : err),
    );
    child.on('close', (code) => {
      if (code === 0) return resolve({ dir: dest, existed: false });
      fs.rmSync(dest, { recursive: true, force: true });
      const last = stderr.trim().split(/\r?\n/).pop() || `git exited ${code}`;
      reject(new Error(last));
    });
  });
}

/** Most recent first, without duplicates, at most `max`. */
function remember(list, dir, max = 8) {
  return [dir, ...(Array.isArray(list) ? list : []).filter((d) => d && d !== dir)].slice(0, max);
}

module.exports = { parseRepo, cloneRepo, remember, reposRoot };
