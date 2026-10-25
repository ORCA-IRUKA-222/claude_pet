'use strict';

// "Pause" requests from the pet. The pet drops a marker file per session; the
// PreToolUse gate hook removes it on Claude's next tool call and stops the turn.
// A file (not a request to the pet) keeps the gate fast: no network on the hot path.

const fs = require('fs');
const path = require('path');
const { homeDir } = require('./config');

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function pauseFile(sessionId) {
  if (!SAFE_ID.test(String(sessionId || ''))) return null;
  return path.join(homeDir(), 'pause', sessionId);
}

function requestPause(sessionId) {
  const file = pauseFile(sessionId);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(Date.now()));
  return true;
}

function cancelPause(sessionId) {
  const file = pauseFile(sessionId);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function isPauseRequested(sessionId) {
  const file = pauseFile(sessionId);
  return Boolean(file) && fs.existsSync(file);
}

/** Consume a pause request. Unlinking is atomic, so only one parallel tool call gets it. */
const takePause = cancelPause;

module.exports = { pauseFile, requestPause, cancelPause, isPauseRequested, takePause };
