'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDir } = require('./helpers');

process.env.CLAUDE_PET_HOME = tempDir();
const { loadCloudSessions, saveCloudSessions } = require('../src/core/cloud-store');
const { SessionTracker } = require('../src/core/sessions');

const cloud = (id, ago, extra = {}) => ({
  id,
  source: 'cloud',
  url: `https://claude.ai/code/session_${id}`,
  cwd: '/home/user/app',
  title: `task ${id}`,
  updatedAt: Date.now() - ago,
  ...extra,
});

test('cloud sessions are remembered across restarts, recent ones only', () => {
  const now = Date.now();
  const list = [
    cloud('A', 60e3),
    cloud('B', 8 * 24 * 3600e3), // older than a week
    { ...cloud('C', 1000), url: null }, // the relay test has no link
    { id: 'local', source: 'cli', updatedAt: now },
  ];
  assert.equal(saveCloudSessions(list, 'm42', { now }), true);
  assert.equal(saveCloudSessions(list, 'm42', { now }), false, 'nothing new, nothing written');
  const { sessions, lastId } = loadCloudSessions({ now });
  assert.equal(lastId, 'm42');
  assert.deepEqual(
    sessions.map((s) => s.id),
    ['A'],
  );

  // after a restart they are back in the list, still linking to claude.ai
  const tracker = new SessionTracker();
  tracker.seed(sessions.map((s) => ({ ...s, source: 'cloud' })));
  const [restored] = tracker.list();
  assert.equal(restored.source, 'cloud');
  assert.equal(restored.url, 'https://claude.ai/code/session_A');
  assert.equal(restored.effectiveStatus, 'idle');
});

test('a cloud session that ends stays in the list; a local one goes', () => {
  const tracker = new SessionTracker();
  tracker.handle({
    event: 'UserPromptSubmit',
    session_id: 'c1',
    source: 'cloud',
    url: 'https://claude.ai/code/session_X',
    ts: 1,
  });
  tracker.handle({ event: 'UserPromptSubmit', session_id: 'l1', cwd: '/w', ts: 1 });
  tracker.handle({ event: 'SessionEnd', session_id: 'c1', ts: 2 });
  tracker.handle({ event: 'SessionEnd', session_id: 'l1', ts: 2 });
  const ids = tracker.list().map((s) => s.id);
  assert.deepEqual(ids, ['c1']);
  assert.equal(tracker.list()[0].effectiveStatus, 'idle');
});
