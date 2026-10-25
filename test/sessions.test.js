'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionTracker } = require('../src/core/sessions');

function setup() {
  let now = 1_000_000;
  let ts = 0;
  const tracker = new SessionTracker({ now: () => now, staleMs: 60_000, expireMs: 600_000 });
  const send = (event, extra = {}) => tracker.handle({ session_id: 's1', cwd: '/work/app', event, ts: ++ts, ...extra });
  return { tracker, send, advance: (ms) => (now += ms) };
}

test('a normal turn goes running → ready (unread) → idle after reading', () => {
  const { tracker, send } = setup();
  send('SessionStart');
  assert.equal(tracker.aggregate().status, 'idle');

  send('UserPromptSubmit', { prompt: 'fix the bug' });
  assert.equal(tracker.aggregate().status, 'running');

  send('PreToolUse', { tool_name: 'Read', tool: 'app.js' });
  const reading = tracker.aggregate();
  assert.equal(reading.activity, 'reading');
  assert.equal(reading.primary.detail, 'Read: app.js');

  send('PostToolUse', { tool_name: 'Read' });
  send('Stop', { message: 'Fixed it.' });
  const done = tracker.aggregate();
  assert.equal(done.status, 'ready');
  assert.equal(done.primary.message, 'Fixed it.');
  assert.equal(done.counts.ready, 1);

  tracker.markRead('s1');
  assert.equal(tracker.aggregate().status, 'idle');
});

test('permission requests wait until that tool finishes', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('PreToolUse', { tool_name: 'Bash', tool: 'rm -rf build' });
  send('PreToolUse', { tool_name: 'Read', tool: 'a.js' });
  send('PermissionRequest', { tool_name: 'Bash', tool: 'rm -rf build' });
  assert.equal(tracker.aggregate().status, 'waiting');

  // A parallel tool finishing doesn't answer the open prompt.
  send('PostToolUse', { tool_name: 'Read' });
  assert.equal(tracker.aggregate().status, 'waiting');

  send('PostToolUse', { tool_name: 'Bash' });
  assert.equal(tracker.aggregate().status, 'running');
});

test('AskUserQuestion counts as waiting for the user', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('PreToolUse', { tool_name: 'AskUserQuestion', tool: 'Which database?' });
  const agg = tracker.aggregate();
  assert.equal(agg.status, 'waiting');
  assert.equal(agg.activity, 'question');
  send('PostToolUse', { tool_name: 'AskUserQuestion' });
  assert.equal(tracker.aggregate().status, 'running');
});

test('permission_prompt notification without a PermissionRequest still waits', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(tracker.aggregate().status, 'waiting');
  send('PreToolUse', { tool_name: 'Bash' });
  assert.equal(tracker.aggregate().status, 'running');
});

test('StopFailure is shown as failed until read', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('StopFailure', { error: 'rate_limit', message: 'API Error: Rate limit reached' });
  const agg = tracker.aggregate();
  assert.equal(agg.status, 'failed');
  assert.equal(agg.primary.error, 'rate_limit');
  tracker.markRead('s1');
  assert.equal(tracker.aggregate().status, 'idle');
});

test('an interrupted turn falls back to idle on idle_prompt', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('Notification', { notification_type: 'idle_prompt' });
  assert.equal(tracker.aggregate().status, 'idle');
});

test('late (out-of-order) events from async hooks are ignored', () => {
  const { tracker } = setup();
  tracker.handle({ session_id: 's1', event: 'UserPromptSubmit', ts: 10 });
  tracker.handle({ session_id: 's1', event: 'Stop', ts: 30 });
  tracker.handle({ session_id: 's1', event: 'PostToolUse', tool_name: 'Read', ts: 20 });
  assert.equal(tracker.aggregate().status, 'ready');
});

test('compaction while idle returns to the previous state', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('Stop', { message: 'done' });
  send('PreCompact', { trigger: 'manual' });
  assert.equal(tracker.aggregate().status, 'running');
  send('PostCompact', { trigger: 'manual' });
  assert.equal(tracker.aggregate().status, 'ready');
});

test('SessionEnd removes the session', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('SessionEnd', { reason: 'prompt_input_exit' });
  assert.equal(tracker.aggregate().total, 0);
});

test('the most urgent session is primary', () => {
  const { tracker } = setup();
  tracker.handle({ session_id: 'a', cwd: '/w/a', event: 'UserPromptSubmit', ts: 1 });
  tracker.handle({ session_id: 'b', cwd: '/w/b', event: 'UserPromptSubmit', ts: 2 });
  tracker.handle({ session_id: 'b', event: 'Stop', ts: 3 });
  tracker.handle({ session_id: 'c', cwd: '/w/c', event: 'PermissionRequest', tool_name: 'Bash', ts: 4 });
  const agg = tracker.aggregate();
  assert.equal(agg.status, 'waiting');
  assert.equal(agg.primary.project, 'c');
  assert.deepEqual(
    tracker.list().map((s) => s.project),
    ['c', 'a', 'b'],
  );
});

test('quiet sessions go stale and then expire', () => {
  const { tracker, send, advance } = setup();
  send('UserPromptSubmit');
  advance(61_000);
  tracker.prune();
  const s = tracker.list()[0];
  assert.equal(s.status, 'idle');
  assert.equal(s.stale, true);
  advance(600_000);
  tracker.prune();
  assert.equal(tracker.list().length, 0);
});

test('transitions are emitted', () => {
  const { tracker, send } = setup();
  const seen = [];
  tracker.on('transition', ({ from, to }) => seen.push(`${from}>${to}`));
  send('UserPromptSubmit');
  send('PreToolUse', { tool_name: 'Edit' });
  send('Stop');
  assert.deepEqual(seen, ['idle>running', 'running>ready']);
});

test('invalid events are ignored', () => {
  const { tracker } = setup();
  assert.equal(tracker.handle(null), null);
  assert.equal(tracker.handle({ event: 'Stop' }), null);
  assert.equal(tracker.handle({ session_id: 's', event: 'UserPromptExpansion' }), null);
  assert.equal(tracker.handle({ session_id: 's', event: 'UserPromptSubmit', prompt: '/pet hide' }), null);
  assert.equal(tracker.list().length, 0);
});

test('a turn records how long Claude worked', () => {
  const { tracker } = setup();
  tracker.handle({ session_id: 's1', event: 'UserPromptSubmit', ts: 10_000 });
  assert.equal(tracker.list()[0].turnStartedAt, 10_000);
  tracker.handle({ session_id: 's1', event: 'Stop', ts: 82_000 });
  const s = tracker.list()[0];
  assert.equal(s.turnStartedAt, null);
  assert.equal(s.lastDuration, 72_000);
  tracker.handle({ session_id: 's1', event: 'UserPromptSubmit', ts: 90_000 });
  assert.equal(tracker.list()[0].lastDuration, null);
});

test('files changed in this turn are listed, reset by the next prompt', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('PostToolUse', { tool_name: 'Edit', file_path: '/work/app/a.js' });
  send('PostToolUse', { tool_name: 'Write', file_path: '/work/app/b.js' });
  send('PostToolUse', { tool_name: 'Edit', file_path: '/work/app/a.js' });
  assert.deepEqual(tracker.list()[0].files, ['/work/app/a.js', '/work/app/b.js']);
  assert.ok(tracker.hasFile('s1', '/work/app/b.js'));
  assert.ok(!tracker.hasFile('s1', '/etc/passwd'));
  send('UserPromptSubmit');
  assert.deepEqual(tracker.list()[0].files, []);
});

test("Claude's to-do list from TodoWrite and from TaskCreate/TaskUpdate", () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  send('PreToolUse', {
    tool_name: 'TodoWrite',
    todos: [
      { text: 'Read code', status: 'completed' },
      { text: 'Fix bug', active: 'Fixing bug', status: 'in_progress' },
      { text: 'Add test', status: 'pending' },
    ],
  });
  assert.deepEqual(tracker.list()[0].todoProgress, { done: 1, total: 3, current: 'Fixing bug' });

  const t = setup();
  t.send('UserPromptSubmit');
  t.send('TaskCreated', { task: { id: '1', subject: 'Plan', status: 'pending' } });
  t.send('TaskCreated', { task: { id: '2', subject: 'Build', status: 'pending' } });
  t.send('PostToolUse', { tool_name: 'TaskUpdate', task: { id: '1', status: 'in_progress', active: 'Planning' } });
  assert.deepEqual(t.tracker.list()[0].todoProgress, { done: 0, total: 2, current: 'Planning' });
  t.send('TaskCompleted', { task: { id: '1', status: 'completed' } });
  t.send('PostToolUse', { tool_name: 'TaskUpdate', task: { id: '2', status: 'completed' } });
  assert.deepEqual(t.tracker.list()[0].todoProgress, { done: 2, total: 2, current: null });
  assert.equal(t.tracker.list()[0].todos[0].text, 'Plan');

  // A finished list is cleared when the next piece of work starts; an unfinished one stays.
  t.send('UserPromptSubmit');
  assert.equal(t.tracker.list()[0].todoProgress, null);
  t.send('TaskCreated', { task: { id: '3', subject: 'Next' } });
  t.send('PostToolUse', { tool_name: 'TaskUpdate', task: { id: '3', status: 'deleted' } });
  assert.equal(t.tracker.list()[0].todos.length, 0);
});

test('pausing from the pet ends the turn as idle', () => {
  const { tracker, send } = setup();
  send('UserPromptSubmit');
  tracker.setPauseRequested('s1', true);
  assert.equal(tracker.list()[0].pauseRequested, true);
  send('PetPaused');
  const s = tracker.list()[0];
  assert.equal(s.status, 'idle');
  assert.equal(s.paused, true);
  assert.equal(s.pauseRequested, false);
  assert.equal(typeof s.lastDuration, 'number');
  send('UserPromptSubmit');
  assert.equal(tracker.list()[0].paused, false);
});
