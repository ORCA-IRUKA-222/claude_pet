#!/usr/bin/env node
'use strict';

// Hook for cloud sessions (Claude Code on the web and in the Claude app). The pet on your
// computer can't be reached from the cloud, so each event is encrypted and published to an
// ntfy topic that the pet listens to. Like the local hook it never prints and always exits 0.
//
//   node cloud-hook.js --install   register it (the cloud environment's setup script does this)

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { compact } = require('./pet-hook');
const { seal } = require('../shared/seal');

// State changes only: the free relay has rate limits, so tool events are thinned out below.
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];
const TOOL_EVENT_EVERY_MS = 3 * 60e3; // keeps a long turn from looking stale on the pet
const MAX_BODY = 2800; // ntfy keeps messages up to 4 KB as text; base64 adds a third
const HOOK_TIMEOUT_S = 10;

function stateDir() {
  return process.env.CLAUDE_PET_CLOUD_HOME || path.join(os.homedir(), '.claude-pet-cloud');
}

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(stateDir(), 'config.json'), 'utf8'));
    return c && c.topic && c.key ? { server: 'https://ntfy.sh', ...c } : null;
  } catch {
    return null;
  }
}

/** The event to relay, or null when it should be skipped. */
function cloudEvent(input, env = process.env) {
  const event = compact(input);
  event.source = 'cloud';
  delete event.term;
  const remote = env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (remote && /^cse_[A-Za-z0-9]+$/.test(remote)) event.url = `https://claude.ai/code/${remote.replace(/^cse_/, 'session_')}`;
  // shorten the longest texts until the sealed message fits
  for (const key of ['message', 'error_details', 'prompt', 'title']) {
    while (typeof event[key] === 'string' && Buffer.byteLength(JSON.stringify(event)) > MAX_BODY) {
      event[key] = event[key].length > 40 ? event[key].slice(0, Math.floor(event[key].length / 2)) + '…' : undefined;
    }
  }
  return event;
}

/**
 * Claude Code may load this hook from two settings files (see install); the first run for
 * a given input claims it. Tool events are also thinned out to one every few minutes.
 */
function shouldSend(raw, event, now = Date.now()) {
  const dir = path.join(stateDir(), 'sent');
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > 10 * 60e3) fs.rmSync(file, { force: true });
    }
  } catch {
    // another run is cleaning up
  }
  try {
    const id = crypto.createHash('sha1').update(raw).digest('hex');
    fs.writeFileSync(path.join(dir, id), '', { flag: 'wx' });
  } catch {
    return false;
  }
  if (event.event !== 'PreToolUse') return true;
  const mark = path.join(stateDir(), `tool-${crypto.createHash('sha1').update(event.session_id).digest('hex')}`);
  try {
    if (now - fs.statSync(mark).mtimeMs < TOOL_EVENT_EVERY_MS) return false;
  } catch {
    // first tool event of this session
  }
  fs.writeFileSync(mark, '');
  return true;
}

function publish({ server, topic }, body) {
  return new Promise((resolve) => {
    const url = new URL(`${server.replace(/\/+$/, '')}/${topic}`);
    const req = (url.protocol === 'http:' ? http : https).request(
      url,
      { method: 'POST', headers: { 'content-type': 'text/plain' }, timeout: 3000 },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', resolve);
    req.end(body);
  });
}

function hookHandler(event, script) {
  const handler = { type: 'command', command: process.execPath, args: [script], timeout: HOOK_TIMEOUT_S };
  // tool events don't need to hold Claude up
  if (event === 'PreToolUse') handler.async = true;
  return handler;
}

const isOurs = (h) => h && Array.isArray(h.args) && h.args.some((a) => String(a).endsWith('cloud-hook.js'));

function addHooks(settings, script) {
  const hooks = { ...(settings.hooks || {}) };
  for (const event of EVENTS) {
    const groups = (hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    hooks[event] = [...groups, { hooks: [hookHandler(event, script)] }];
  }
  return { ...settings, hooks };
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Register the hook in the user settings and, when writable, in a managed-settings drop-in:
 * the cloud environment writes ~/.claude/settings.json while it starts up, so the drop-in
 * keeps working even if that file is replaced after the setup script ran.
 */
function install({
  home = os.homedir(),
  managedDir = process.env.CLAUDE_PET_MANAGED_DIR || '/etc/claude-code/managed-settings.d',
  script = __filename,
} = {}) {
  const written = [];
  const userFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify(addHooks(readJSON(userFile), script), null, 2) + '\n');
  written.push(userFile);
  try {
    fs.mkdirSync(managedDir, { recursive: true });
    const dropIn = path.join(managedDir, 'claude-pet.json');
    fs.writeFileSync(dropIn, JSON.stringify(addHooks({}, script), null, 2) + '\n');
    written.push(dropIn);
  } catch {
    // not root: the user settings will do
  }
  return written;
}

function main() {
  setTimeout(() => process.exit(0), (HOOK_TIMEOUT_S - 2) * 1000).unref();
  if (process.stdin.isTTY) process.exit(0);
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', async () => {
    try {
      const config = readConfig();
      const raw = Buffer.concat(chunks);
      const input = JSON.parse(raw.toString('utf8'));
      if (!config || !input || !input.hook_event_name || !input.session_id) process.exit(0);
      const event = cloudEvent(input);
      if (shouldSend(raw, event)) await publish(config, seal(event, config.key));
    } catch {
      // never disturb the session
    }
    process.exit(0);
  });
}

if (require.main === module) {
  if (process.argv.includes('--install')) {
    for (const file of install()) console.log(`claude-pet: hooks added to ${file}`);
  } else main();
}

module.exports = { cloudEvent, addHooks, install, shouldSend, publish, EVENTS, MAX_BODY };
