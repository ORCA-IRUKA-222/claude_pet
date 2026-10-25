'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { startServer } = require('../src/core/server');
const { compact } = require('../src/hook/pet-hook');
const { freePort, tempDir } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'src', 'hook', 'pet-hook.js');

function runHook(input, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CLAUDE_PET_PORT: String(port), CLAUDE_PET_HOME: tempDir() },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

function rawRequest(port, { method = 'POST', path: urlPath = '/event', headers = {}, body = '{}' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('compact() keeps only what the pet needs', () => {
  const event = compact({
    hook_event_name: 'PreToolUse',
    session_id: 'abc',
    cwd: '/w/app',
    tool_name: 'Write',
    tool_input: { file_path: '/w/app/src/index.js', content: 'x'.repeat(100000) },
  });
  assert.equal(event.tool, 'index.js');
  assert.ok(JSON.stringify(event).length < 1000);

  const stop = compact({ hook_event_name: 'Stop', session_id: 'abc', last_assistant_message: 'y'.repeat(10000) });
  assert.ok(stop.message.length <= 4000);
});

test('hook delivers events to the server and prints nothing', async () => {
  const port = await freePort();
  const received = [];
  const server = await startServer({
    port,
    onEvent: (e) => received.push(e),
    onControl: async () => ({}),
    getStatus: () => ({}),
  });
  try {
    const result = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/w/app', prompt: 'hello' }, port);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(received.length, 1);
    assert.equal(received[0].event, 'UserPromptSubmit');
    assert.equal(received[0].prompt, 'hello');
    assert.equal(typeof received[0].ts, 'number');
  } finally {
    server.close();
  }
});

test('hook exits 0 quickly when the pet is not running', async () => {
  const port = await freePort();
  const started = Date.now();
  const result = await runHook({ hook_event_name: 'Stop', session_id: 's1' }, port);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.ok(Date.now() - started < 2500);
});

test('hook ignores garbage input', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: 'not json', env: { ...process.env, CLAUDE_PET_PORT: '1' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), '');
});

test('server rejects browser and cross-host requests', async () => {
  const port = await freePort();
  const received = [];
  const server = await startServer({
    port,
    onEvent: (e) => received.push(e),
    onControl: async () => ({}),
    getStatus: () => ({}),
  });
  const json = { 'content-type': 'application/json' };
  try {
    assert.equal(await rawRequest(port, { headers: { ...json, origin: 'https://evil.example' } }), 403);
    assert.equal(await rawRequest(port, { headers: { ...json, host: 'evil.example:80' } }), 403);
    assert.equal(await rawRequest(port, { headers: { 'content-type': 'text/plain' } }), 415);
    assert.equal(await rawRequest(port, { headers: json, body: '{bad' }), 400);
    assert.equal(await rawRequest(port, { headers: json, body: JSON.stringify({ event: 'Stop', session_id: 'x' }) }), 204);
    assert.equal(await rawRequest(port, { method: 'GET', path: '/health' }), 200);
    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test('server refuses to start twice on the same port', async () => {
  const port = await freePort();
  const opts = { port, onEvent() {}, onControl: async () => ({}), getStatus: () => ({}) };
  const server = await startServer(opts);
  try {
    await assert.rejects(startServer(opts), /EADDRINUSE/);
  } finally {
    server.close();
  }
});

test('the hook tells the pet where Claude Code runs from', () => {
  const saved = process.env.CLAUDE_CODE_EXECPATH;
  process.env.CLAUDE_CODE_EXECPATH = '/opt/claude-code/bin/claude';
  try {
    assert.equal(compact({ hook_event_name: 'SessionStart', session_id: 'abc' }).claude_path, '/opt/claude-code/bin/claude');
    assert.equal(compact({ hook_event_name: 'PreToolUse', session_id: 'abc' }).claude_path, undefined);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_EXECPATH;
    else process.env.CLAUDE_CODE_EXECPATH = saved;
  }
});
