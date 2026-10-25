'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { candidates, pickNext, isDue, groups } = require('../src/core/rotation');
const { parseRotateArgs, parseMinutes } = require('../bin/claude-pet');
const { freePort, tempDir } = require('./helpers');

const PETS = [
  { key: 'mochi', id: 'mochi', group: null },
  { key: 'a', id: 'a', group: 'Team' },
  { key: 'b', id: 'b', group: 'Team' },
  { key: 'c', id: 'c', group: 'Team' },
  { key: 'x', id: 'x', group: 'Other' },
];

test('candidates follow the explicit list, then the group, then everything', () => {
  assert.deepEqual(candidates(PETS, {}), ['mochi', 'a', 'b', 'c', 'x']);
  assert.deepEqual(candidates(PETS, { group: 'Team' }), ['a', 'b', 'c']);
  assert.deepEqual(candidates(PETS, { group: 'Team', pets: ['x', 'mochi'] }), ['mochi', 'x']);
  assert.deepEqual(groups(PETS), ['Other', 'Team']);
});

test('shuffle shows every pet once before repeating, never the current one twice in a row', () => {
  const keys = ['a', 'b', 'c', 'd'];
  let current = 'a';
  let queue = [];
  const seen = [];
  for (let i = 0; i < 3; i++) {
    ({ next: current, queue } = pickNext(keys, current, { queue }));
    seen.push(current);
  }
  assert.deepEqual([...seen].sort(), ['b', 'c', 'd']);
  const after = pickNext(keys, current, { queue });
  assert.notEqual(after.next, current);
});

test('sequence order walks the keys in order', () => {
  assert.equal(pickNext(['a', 'b', 'c'], 'b', { order: 'sequence' }).next, 'c');
  assert.equal(pickNext(['a', 'b', 'c'], 'c', { order: 'sequence' }).next, 'a');
});

test('nothing to switch to', () => {
  assert.equal(pickNext(['a'], 'a').next, null);
  assert.equal(pickNext([], 'a').next, null);
  assert.equal(pickNext(['a'], 'mochi').next, 'a'); // the current pet is outside the set
});

test('isDue respects enabled and the interval', () => {
  const now = 10 * 3600e3;
  assert.equal(isDue({ enabled: false, intervalMinutes: 60, lastChangedAt: 0 }, now), false);
  assert.equal(isDue({ enabled: true, intervalMinutes: 60, lastChangedAt: now - 59 * 60e3 }, now), false);
  assert.equal(isDue({ enabled: true, intervalMinutes: 60, lastChangedAt: now - 60 * 60e3 }, now), true);
});

test('rotate arguments', () => {
  assert.equal(parseMinutes('90'), 90);
  assert.equal(parseMinutes('2h'), 120);
  assert.equal(parseMinutes('1時間'), 60);
  assert.equal(parseMinutes('30分'), 30);
  assert.equal(parseMinutes('soon'), null);
  assert.deepEqual(parseRotateArgs(['on', '--every', '60']), { enabled: true, intervalMinutes: 60 });
  assert.deepEqual(parseRotateArgs(['30']), { intervalMinutes: 30, enabled: true });
  assert.deepEqual(parseRotateArgs(['off']), { enabled: false });
  assert.deepEqual(parseRotateArgs(['on', '--group', '765PRO', 'ALLSTARS']), {
    enabled: true,
    group: '765PRO ALLSTARS',
    pets: [],
  });
  assert.deepEqual(parseRotateArgs(['--group', 'Sample', 'Team', '--every', '30']), {
    group: 'Sample Team',
    pets: [],
    intervalMinutes: 30,
  });
  assert.deepEqual(parseRotateArgs(['--all']), { group: null, pets: [] });
});

test('`claude-pet rotate` saves the setting while the app is not running', async () => {
  const home = tempDir();
  const env = { ...process.env, CLAUDE_PET_HOME: home, CLAUDE_PET_PORT: String(await freePort()) };
  const cli = path.join(__dirname, '..', 'bin', 'claude-pet.js');
  const out = spawnSync(process.execPath, [cli, 'rotate', 'on', '--every', '2h'], { env }).stdout.toString();
  assert.match(out, /2 時間ごと/);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(saved.rotation.enabled, true);
  assert.equal(saved.rotation.intervalMinutes, 120);

  const missing = spawnSync(process.execPath, [cli, 'rotate', 'on', '--group', 'Nobody'], { env }).stdout.toString();
  assert.match(missing, /見つかりません/);
});
