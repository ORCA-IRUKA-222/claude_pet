'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempDir } = require('./helpers');

process.env.CLAUDE_PET_HOME = tempDir();
const { log, tailLog, logFile } = require('../src/core/log');

test('the log keeps what happened, newest last, and cuts itself down when it grows', () => {
  assert.deepEqual(tailLog(), []);
  log('start', new Date(2026, 10, 10, 9, 5, 7));
  log('window shown (ready)\n');
  assert.deepEqual(tailLog(), ['2026-11-10 09:05:07 start', tailLog()[1]]);
  assert.match(tailLog()[1], /window shown \(ready\)$/);

  const line = 'x'.repeat(1000);
  for (let i = 0; i < 200; i++) log(`${i} ${line}`);
  assert.ok(fs.statSync(logFile()).size < 140 * 1024, 'cut down');
  assert.match(tailLog(1)[0], /^\S+ \S+ 199 x+$/, 'the newest line is kept');
});
