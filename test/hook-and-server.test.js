'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { startServer } = require('../src/core/server');
const { compact } = require('../src/hook/pet-hook');
const { PermissionBroker } = require('../src/core/permissions');
const { freePort, tempDir } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'src', 'hook', 'pet-hook.js');

function runHook(input, port, { args = [], home = tempDir() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      env: { ...process.env, CLAUDE_PET_PORT: String(port), CLAUDE_PET_HOME: home },
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

test("compact() passes full paths of edited files and Claude's to-do list", () => {
  const edit = compact({
    hook_event_name: 'PostToolUse',
    session_id: 'abc',
    tool_name: 'Edit',
    tool_input: { file_path: '/w/app/src/a.js', old_string: 'x', new_string: 'y' },
  });
  assert.equal(edit.file_path, '/w/app/src/a.js');
  assert.equal(edit.tool, 'a.js');
  const relative = compact({
    hook_event_name: 'PostToolUse',
    session_id: 'abc',
    tool_name: 'Write',
    tool_input: { file_path: 'rel.js' },
  });
  assert.equal(relative.file_path, undefined);

  const todo = compact({
    hook_event_name: 'PreToolUse',
    session_id: 'abc',
    tool_name: 'TodoWrite',
    tool_input: { todos: [{ content: 'Fix bug', activeForm: 'Fixing bug', status: 'in_progress' }] },
  });
  assert.deepEqual(todo.todos, [{ text: 'Fix bug', active: 'Fixing bug', status: 'in_progress' }]);

  const update = compact({
    hook_event_name: 'PostToolUse',
    session_id: 'abc',
    tool_name: 'TaskUpdate',
    tool_input: { taskId: '3', status: 'completed' },
  });
  assert.deepEqual(update.task, { id: '3', status: 'completed', subject: undefined, active: undefined });

  const created = compact({ hook_event_name: 'TaskCreated', session_id: 'abc', task_id: 7, task_subject: 'Write docs' });
  assert.deepEqual(created.task, { id: '7', subject: 'Write docs', status: 'pending' });
});

function petHome({ secret = 'f'.repeat(64), config = {} } = {}) {
  const home = tempDir();
  if (secret) fs.writeFileSync(path.join(home, 'secret'), secret + '\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}

async function permissionServer(answer, { secret = 'f'.repeat(64) } = {}) {
  const port = await freePort();
  const broker = new PermissionBroker({ timeoutMs: 5000 });
  const received = [];
  broker.on('change', () => {
    const [entry] = broker.list();
    if (entry && answer) setTimeout(() => broker.answer(entry.id, answer), 20);
  });
  const server = await startServer({
    port,
    secret,
    onEvent: (e) => received.push(e),
    onControl: async () => ({}),
    getStatus: () => ({}),
    onPermission: (event, opts) => broker.request(event, opts),
  });
  return { port, server, received, broker };
}

const PERMISSION_INPUT = {
  hook_event_name: 'PermissionRequest',
  session_id: 's1',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run tests' },
};

test('PermissionRequest: 許可 in the pet becomes the hook decision', async () => {
  const { port, server, received } = await permissionServer('allow');
  try {
    const result = await runHook(PERMISSION_INPUT, port, { home: petHome() });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    assert.equal(received[0].event, 'PermissionRequest', 'the pet still sees the request');
  } finally {
    server.close();
  }
});

test('PermissionRequest: 拒否 tells Claude it was denied from the pet', async () => {
  const { port, server } = await permissionServer('deny');
  try {
    const result = await runHook(PERMISSION_INPUT, port, { home: petHome() });
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(out.hookSpecificOutput.decision.message, /ペット/);
  } finally {
    server.close();
  }
});

test('PermissionRequest: answers signed with another secret are ignored', async () => {
  const { port, server } = await permissionServer('allow', { secret: 'e'.repeat(64) });
  try {
    const result = await runHook(PERMISSION_INPUT, port, { home: petHome() });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
  } finally {
    server.close();
  }
});

test('PermissionRequest: "answer in terminal", disabled, or no secret → no decision', async () => {
  const { port, server, received } = await permissionServer(null);
  const terminal = await permissionServer('terminal');
  try {
    const t1 = await runHook(PERMISSION_INPUT, terminal.port, { home: petHome() });
    assert.equal(t1.stdout, '');

    const disabled = await runHook(PERMISSION_INPUT, port, {
      home: petHome({ config: { permissionPrompt: { enabled: false } } }),
    });
    assert.equal(disabled.stdout, '');
    const noSecret = await runHook(PERMISSION_INPUT, port, { home: petHome({ secret: null }) });
    assert.equal(noSecret.stdout, '');
    assert.equal(received.length, 2, 'both still reach the pet as plain events');
  } finally {
    server.close();
    terminal.server.close();
  }
});

test('pause gate: stops the turn once, then lets tools through', async () => {
  const port = await freePort();
  const received = [];
  const server = await startServer({
    port,
    onEvent: (e) => received.push(e),
    onControl: async () => ({}),
    getStatus: () => ({}),
  });
  const home = petHome();
  const input = { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'ls' } };
  try {
    const idle = await runHook(input, port, { home, args: ['--gate'] });
    assert.equal(idle.stdout, '');
    assert.equal(received.length, 0, 'the gate sends nothing when not paused');

    fs.mkdirSync(path.join(home, 'pause'));
    fs.writeFileSync(path.join(home, 'pause', 'sess-1'), '1');
    const paused = await runHook(input, port, { home, args: ['--gate'] });
    const out = JSON.parse(paused.stdout);
    assert.equal(out.continue, false);
    assert.match(out.stopReason, /一時停止/);
    assert.equal(received[0].event, 'PetPaused');
    assert.ok(!fs.existsSync(path.join(home, 'pause', 'sess-1')));

    const after = await runHook(input, port, { home, args: ['--gate'] });
    assert.equal(after.stdout, '');
  } finally {
    server.close();
  }
});

test('server answers /permission with an empty decision when the pet has no handler', async () => {
  const port = await freePort();
  const server = await startServer({ port, onEvent() {}, onControl: async () => ({}), getStatus: () => ({}) });
  const json = { 'content-type': 'application/json' };
  try {
    assert.equal(
      await rawRequest(port, { path: '/permission', headers: json, body: JSON.stringify({ event: {}, nonce: 'bad' }) }),
      400,
    );
    assert.equal(
      await rawRequest(port, {
        path: '/permission',
        headers: json,
        body: JSON.stringify({ event: { event: 'PermissionRequest' }, nonce: 'a'.repeat(32) }),
      }),
      200,
    );
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

test('the browser extension may report events but not control the pet', async () => {
  const port = await freePort();
  const received = [];
  const controls = [];
  const server = await startServer({
    port,
    onEvent: (e, meta) => received.push({ e, meta }),
    onControl: async (c) => controls.push(c),
    getStatus: () => ({}),
  });
  const headers = { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' };
  try {
    const body = JSON.stringify({ event: 'Stop', session_id: 'claude-ai-1' });
    assert.equal(await rawRequest(port, { headers, body }), 204);
    assert.deepEqual(received[0].meta, { fromExtension: true });
    assert.equal(await rawRequest(port, { headers, path: '/control', body: JSON.stringify({ action: 'quit' }) }), 403);
    assert.equal(await rawRequest(port, { headers, method: 'GET', path: '/status' }), 403);
    assert.equal(controls.length, 0);
  } finally {
    server.close();
  }
});
