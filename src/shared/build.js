'use strict';

// Identifies the code on disk (its git commit), so the CLI can tell that a running pet is
// older than the files after `git pull` and restart it.

const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('./config');

function buildId(root = APP_ROOT) {
  try {
    const gitDir = path.join(root, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 12);
    const ref = head.slice(5);
    const loose = path.join(gitDir, ...ref.split('/'));
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 12);
    const line = fs
      .readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 12) : null;
  } catch {
    return null;
  }
}

module.exports = { buildId };
