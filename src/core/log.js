'use strict';

// A small log of what the pet did while starting and why it hid or failed (~/.claude-pet/pet.log),
// so a pet that didn't show up can be explained afterwards. It is cut down when it grows.

const fs = require('fs');
const path = require('path');
const { homeDir } = require('../shared/config');

const MAX_BYTES = 128 * 1024;
const KEEP_BYTES = 64 * 1024;

function logFile() {
  return path.join(homeDir(), 'pet.log');
}

function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

function log(message, now = new Date()) {
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    const file = logFile();
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, text.slice(text.length - KEEP_BYTES).replace(/^[^\n]*\n/, ''));
      }
    } catch {
      // no log yet
    }
    fs.appendFileSync(file, `${stamp(now)} ${String(message).replace(/\s+$/, '')}\n`);
  } catch {
    // logging must never get in the way
  }
}

/** The last lines of the log, newest last. */
function tailLog(lines = 20) {
  try {
    return fs.readFileSync(logFile(), 'utf8').trimEnd().split('\n').slice(-lines);
  } catch {
    return [];
  }
}

module.exports = { log, tailLog, logFile };
