'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempDir } = require('./helpers');
const { MemoStore } = require('../src/core/memos');
const { PermissionBroker, sign, verify } = require('../src/core/permissions');

test('memos are saved, listed open-first, and survive a reload', () => {
  const file = path.join(tempDir(), 'memos.json');
  let now = 1000;
  const store = new MemoStore({ file, now: () => now++ });
  const a = store.add({ text: '  buy milk  ' });
  const b = store.add({ text: 'review PR', cwd: '/work/app' });
  assert.equal(a.text, 'buy milk');
  assert.equal(b.project, 'app');
  assert.throws(() => store.add({ text: '   ' }));

  store.update(b.id, { done: true });
  assert.deepEqual(
    store.list().map((m) => m.text),
    ['buy milk', 'review PR'],
  );

  const reloaded = new MemoStore({ file });
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.clearDone(), 1);
  assert.ok(reloaded.remove(a.id));
  assert.equal(new MemoStore({ file }).list().length, 0);
});

test('a permission request waits for the answer from the pet', async () => {
  const broker = new PermissionBroker({ timeoutMs: 5000 });
  const pending = broker.request({ session_id: 's1', tool_name: 'Bash', tool: 'npm test' });
  const [entry] = broker.list();
  assert.equal(entry.sessionId, 's1');
  assert.equal(entry.tool, 'npm test');
  assert.ok(broker.answer(entry.id, 'allow'));
  assert.deepEqual(await pending, { behavior: 'allow' });
  assert.equal(broker.list().length, 0);
  assert.equal(broker.answer(entry.id, 'deny'), false);
});

test('answering in the terminal releases the pet’s buttons', async () => {
  const broker = new PermissionBroker({ timeoutMs: 5000 });
  const bash = broker.request({ session_id: 's1', tool_name: 'Bash' });
  const other = broker.request({ session_id: 's2', tool_name: 'Edit' });

  broker.observe({ event: 'PostToolUse', session_id: 's1', tool_name: 'Read' }); // a parallel tool
  assert.equal(broker.list().length, 2);
  broker.observe({ event: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });
  assert.equal(await bash, null);
  assert.equal(broker.list().length, 1);

  broker.observe({ event: 'Stop', session_id: 's2' });
  assert.equal(await other, null);
});

test('permission requests time out and can be aborted', async () => {
  const broker = new PermissionBroker({ timeoutMs: 30 });
  assert.equal(await broker.request({ session_id: 's1' }), null);

  const controller = new AbortController();
  const aborted = broker.request({ session_id: 's1' }, { signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, null);
  assert.equal(broker.list().length, 0);
});

test('answers are signed with the shared secret', () => {
  const secret = 'a'.repeat(64);
  const signature = sign(secret, 'nonce', 'allow');
  assert.ok(verify(secret, 'nonce', 'allow', signature));
  assert.ok(!verify(secret, 'nonce', 'deny', signature));
  assert.ok(!verify(secret, 'other', 'allow', signature));
  assert.ok(!verify('b'.repeat(64), 'nonce', 'allow', signature));
  assert.ok(!verify(secret, 'nonce', 'allow', 'nope'));
  assert.ok(!verify(null, 'nonce', 'allow', signature));
});
