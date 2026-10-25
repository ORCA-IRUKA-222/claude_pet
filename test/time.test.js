'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, formatClock, formatSpan } = require('../src/shared/time');

test('parseDuration understands minutes, units, clocks and Japanese', () => {
  assert.equal(parseDuration('25'), 25 * 60e3);
  assert.equal(parseDuration('10m'), 10 * 60e3);
  assert.equal(parseDuration('90s'), 90e3);
  assert.equal(parseDuration('1h30m'), 90 * 60e3);
  assert.equal(parseDuration('1時間30分'), 90 * 60e3);
  assert.equal(parseDuration('３分'), 3 * 60e3);
  assert.equal(parseDuration('5:00'), 5 * 60e3);
  assert.equal(parseDuration('1:05:00'), 65 * 60e3);
  for (const bad of ['', 'abc', '10x', '0', '5:75', '48h', '10m foo']) assert.equal(parseDuration(bad), null, bad);
});

test('formatClock and formatSpan', () => {
  assert.equal(formatClock(272000), '4:32');
  assert.equal(formatClock(3723000), '1:02:03');
  assert.equal(formatClock(-5), '0:00');
  assert.equal(formatSpan(45e3), '45秒');
  assert.equal(formatSpan(12 * 60e3), '12分');
  assert.equal(formatSpan(65 * 60e3), '1時間5分');
  assert.equal(formatSpan(65 * 60e3, 'en'), '1 h 5 min');
});
