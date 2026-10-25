'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { tempDir } = require('./helpers');
const { seal, unseal, newKey, newTopic, TOPIC } = require('../src/shared/seal');
const { cloudEvent, addHooks, install, shouldSend, MAX_BODY } = require('../src/hook/cloud-hook');
const { RelayListener, publish } = require('../src/core/relay');

const HOOK = path.join(__dirname, '..', 'src', 'hook', 'cloud-hook.js');

/** A small stand-in for ntfy: POST /<topic> publishes, GET /<topic>/json streams NDJSON. */
function fakeNtfy() {
  const messages = [];
  const streams = new Set();
  let n = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const [, topic, kind] = url.pathname.split('/');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = { id: `m${++n}`, time: Math.floor(Date.now() / 1000), event: 'message', topic, message: body };
        messages.push(msg);
        for (const s of streams) if (s.topic === topic) s.res.write(JSON.stringify(msg) + '\n');
        res.end(JSON.stringify(msg));
      });
      return;
    }
    if (kind !== 'json') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ id: 'open', event: 'open', topic }) + '\n');
    const since = url.searchParams.get('since');
    const start = messages.findIndex((m) => m.id === since);
    for (const m of messages.slice(start + 1)) if (m.topic === topic) res.write(JSON.stringify(m) + '\n');
    const stream = { topic, res };
    streams.add(stream);
    req.on('close', () => streams.delete(stream));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        messages,
        dropAll: () => streams.forEach((s) => s.res.destroy()),
        close: () => {
          streams.forEach((s) => s.res.destroy());
          server.close();
        },
      });
    }),
  );
}

const nextEvent = (listener) => new Promise((resolve) => listener.once('event', resolve));

test('sealed events open only with the same key', () => {
  const key = newKey();
  const sealed = seal({ hello: 'こんにちは' }, key);
  assert.ok(sealed.startsWith('cp1.'));
  assert.ok(!sealed.includes('hello'));
  assert.deepEqual(unseal(sealed, key), { hello: 'こんにちは' });
  assert.equal(unseal(sealed, newKey()), null);
  assert.equal(unseal('plain text', key), null);
  assert.match(newTopic(), TOPIC);
});

test('cloud events link to the session on claude.ai and stay small enough for ntfy', () => {
  const env = { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01GxmbzUjYnXTchYbFYhhFvJ' };
  const event = cloudEvent(
    { hook_event_name: 'Stop', session_id: 'abc', cwd: '/home/user/app', last_assistant_message: '長い返事。'.repeat(2000) },
    env,
  );
  assert.equal(event.source, 'cloud');
  assert.equal(event.url, 'https://claude.ai/code/session_01GxmbzUjYnXTchYbFYhhFvJ');
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= MAX_BODY);
  assert.ok(event.message.startsWith('長い返事。'));
  assert.ok(seal(event, newKey()).length < 4000);
});

test('the hook is registered once per event, next to existing hooks, in both settings files', () => {
  const settings = { attribution: { commit: '' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/stop.sh' }] }] } };
  const once = addHooks(settings, '/h/.claude-pet-cloud/src/hook/cloud-hook.js');
  const twice = addHooks(once, '/h/.claude-pet-cloud/src/hook/cloud-hook.js');
  assert.deepEqual(twice, once);
  assert.equal(once.attribution.commit, '');
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.hooks.PreToolUse[0].hooks[0].async, true);

  const home = tempDir();
  const managedDir = path.join(tempDir(), 'managed-settings.d');
  const files = install({ home, managedDir, script: '/s/cloud-hook.js' });
  assert.deepEqual(files, [path.join(home, '.claude', 'settings.json'), path.join(managedDir, 'claude-pet.json')]);
  assert.equal(JSON.parse(fs.readFileSync(files[1], 'utf8')).hooks.UserPromptSubmit[0].hooks[0].args[0], '/s/cloud-hook.js');
});

test('a hook loaded twice sends once, and tool events are thinned out', () => {
  process.env.CLAUDE_PET_CLOUD_HOME = tempDir();
  try {
    const stop = { event: 'Stop', session_id: 's1' };
    assert.equal(shouldSend(Buffer.from('{"a":1}'), stop), true);
    assert.equal(shouldSend(Buffer.from('{"a":1}'), stop), false);
    const tool = { event: 'PreToolUse', session_id: 's1' };
    const now = Date.now();
    assert.equal(shouldSend(Buffer.from('{"t":1}'), tool, now), true);
    assert.equal(shouldSend(Buffer.from('{"t":2}'), tool, now + 1000), false);
    assert.equal(shouldSend(Buffer.from('{"t":3}'), { ...tool, session_id: 's2' }, now + 1000), true);
  } finally {
    delete process.env.CLAUDE_PET_CLOUD_HOME;
  }
});

test('the pet receives what the cloud hook publishes, also across a reconnect', async (t) => {
  const ntfy = await fakeNtfy();
  t.after(() => ntfy.close());
  const key = newKey();
  const topic = newTopic();
  const listener = new RelayListener({ server: ntfy.url, topic, key });
  t.after(() => listener.stop());
  const connected = new Promise((resolve) => listener.once('status', resolve));
  listener.start();
  assert.equal(await connected, 'connected');

  // the real hook script, as Claude Code runs it in the cloud
  const home = tempDir();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: ntfy.url, topic, key }));
  const received = nextEvent(listener);
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, CLAUDE_PET_CLOUD_HOME: home, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01ABC' },
  });
  child.stdin.end(
    JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cloud-1', cwd: '/home/user/app', prompt: '直して' }),
  );
  const event = await received;
  assert.equal(event.prompt, '直して');
  assert.equal(event.url, 'https://claude.ai/code/session_01ABC');
  assert.ok(!ntfy.messages[0].message.includes('直して'), 'the relay only sees ciphertext');

  // a message sent while the connection is down arrives after the reconnect
  ntfy.dropAll();
  await publish({ server: ntfy.url, topic }, seal({ event: 'Stop', session_id: 'cloud-1', message: 'done' }, key));
  const later = await nextEvent(listener);
  assert.equal(later.message, 'done');
});
