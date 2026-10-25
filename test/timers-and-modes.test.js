'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TimeKeeper } = require('../src/core/timers');
const { Modes } = require('../src/core/modes');

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test('timer counts down, pauses, and fires once', () => {
  const c = clock();
  const keeper = new TimeKeeper({ now: c.now });
  const done = [];
  keeper.on('timer-done', (e) => done.push(e));

  keeper.startTimer(60e3, 'tea');
  c.advance(20e3);
  keeper.pauseTimer();
  assert.equal(keeper.snapshot().timer.remaining, 40e3);
  c.advance(100e3); // paused time doesn't count
  keeper.resumeTimer();
  c.advance(39e3);
  keeper.check();
  assert.equal(done.length, 0);
  c.advance(1e3);
  keeper.check();
  keeper.check();
  assert.deepEqual(done, [{ label: 'tea', duration: 60e3 }]);
  assert.equal(keeper.snapshot().timer.endsAt, null);
  assert.throws(() => keeper.startTimer(0));
  keeper.dispose();
});

test('stopwatch accumulates across pauses', () => {
  const c = clock();
  const keeper = new TimeKeeper({ now: c.now });
  keeper.startStopwatch();
  c.advance(5e3);
  keeper.pauseStopwatch();
  c.advance(60e3);
  keeper.startStopwatch();
  c.advance(2e3);
  keeper.pauseStopwatch();
  assert.equal(keeper.snapshot().stopwatch.elapsed, 7e3);
  keeper.resetStopwatch();
  assert.equal(keeper.snapshot().stopwatch.elapsed, 0);
  keeper.dispose();
});

test('pomodoro cycles focus → break, with a long break every N rounds', () => {
  const c = clock();
  const keeper = new TimeKeeper({
    now: c.now,
    pomodoro: { focusMinutes: 1, breakMinutes: 1, longBreakMinutes: 2, longBreakEvery: 2 },
  });
  const phases = [];
  keeper.on('pomodoro-phase', (e) => phases.push(e.to));

  keeper.startPomodoro();
  assert.ok(keeper.isFocusing());
  for (let i = 0; i < 3; i++) {
    c.advance(60e3);
    keeper.check();
  }
  assert.deepEqual(phases, ['focus', 'break', 'focus', 'longBreak']);
  assert.equal(keeper.snapshot().pomodoro.round, 2);
  assert.ok(!keeper.isFocusing());

  keeper.skipPomodoro();
  assert.equal(keeper.snapshot().pomodoro.phase, 'focus');
  keeper.pausePomodoro();
  assert.ok(!keeper.isFocusing(), 'a paused focus phase does not hold notifications');
  keeper.stopPomodoro();
  assert.equal(keeper.snapshot().pomodoro.phase, null);
  assert.equal(phases[phases.length - 1], null);
  keeper.dispose();
});

test('pomodoro without autoStart waits at each phase', () => {
  const c = clock();
  const keeper = new TimeKeeper({ now: c.now, pomodoro: { focusMinutes: 1, autoStart: false } });
  keeper.startPomodoro();
  c.advance(60e3);
  keeper.check();
  const p = keeper.snapshot().pomodoro;
  assert.equal(p.phase, 'break');
  assert.equal(p.endsAt, null);
  keeper.startPomodoro(); // resumes the waiting phase
  assert.ok(keeper.snapshot().pomodoro.endsAt);
  keeper.dispose();
});

test('おやすみモード holds bubbles; requests for input get through unless turned off', () => {
  const c = clock();
  const modes = new Modes({ now: c.now });
  assert.equal(modes.holds('ready'), false);

  modes.setDnd({ until: c.now() + 60e3, allowWaiting: true });
  assert.equal(modes.holds('ready'), true);
  assert.equal(modes.holds('failed'), true);
  assert.equal(modes.holds('waiting'), false);
  modes.setDndAllowWaiting(false);
  assert.equal(modes.holds('waiting'), true);

  const digests = [];
  modes.on('digest', (d) => digests.push(d));
  modes.record('ready');
  modes.record('ready');
  modes.record('waiting');
  c.advance(61e3);
  assert.equal(modes.holds('ready'), false, 'expires on its own');
  assert.equal(digests.length, 1);
  assert.equal(digests[0].reason, 'dnd');
  assert.deepEqual(digests[0].counts, { ready: 2, waiting: 1, failed: 0 });
  modes.dispose();
});

test('focus holds finished work but never requests for input', () => {
  const modes = new Modes();
  modes.setFocus(true);
  assert.equal(modes.holds('ready'), true);
  assert.equal(modes.holds('waiting'), false);
  modes.setFocus(false);
  assert.equal(modes.holds('ready'), false);
  modes.dispose();
});

test('away digests count what happened while away', () => {
  const modes = new Modes();
  const digests = [];
  modes.on('digest', (d) => digests.push(d));
  modes.setAway(true);
  assert.equal(modes.holds('ready'), false, 'being away does not hide anything');
  modes.record('ready');
  modes.record('failed');
  modes.record('running');
  modes.setAway(false);
  assert.deepEqual(digests[0].counts, { ready: 1, waiting: 0, failed: 1 });
  modes.dispose();
});

test('おやすみモード is restored from config', () => {
  const c = clock();
  const kept = new Modes({ now: c.now, dnd: { active: true, until: null, allowWaiting: false } });
  assert.deepEqual(kept.snapshot().dnd, { until: null, allowWaiting: false });
  assert.deepEqual(kept.persisted(), { active: true, until: null, allowWaiting: false });
  const expired = new Modes({ now: c.now, dnd: { active: true, until: c.now() - 1 } });
  assert.equal(expired.snapshot().dnd, null);
  kept.dispose();
  expired.dispose();
});
