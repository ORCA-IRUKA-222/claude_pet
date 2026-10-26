'use strict';

// Sessions taken off the list (~/.claude-pet/dismissed.json), so they stay off after the
// history is reloaded or the pet restarts.

const fs = require('fs');
const path = require('path');
const { homeDir } = require('../shared/config');

function dismissedFile() {
  return path.join(homeDir(), 'dismissed.json');
}

function loadDismissed() {
  try {
    const ids = JSON.parse(fs.readFileSync(dismissedFile(), 'utf8')).ids;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveDismissed(ids) {
  fs.mkdirSync(homeDir(), { recursive: true });
  const tmp = `${dismissedFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ids }, null, 2) + '\n');
  fs.renameSync(tmp, dismissedFile());
}

module.exports = { loadDismissed, saveDismissed, dismissedFile };
