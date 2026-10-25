'use strict';

// Timer, stopwatch and pomodoro, kept in the main process so `/pet timer`
// and the panel share one clock. Everything is stored as timestamps, so the
// renderer can draw the countdown itself without an update every second.

const { EventEmitter } = require('events');

const MINUTE = 60e3;

const POMODORO_DEFAULTS = {
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  autoStart: true,
};

function positive(value, fallback, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function pomodoroSettings(settings = {}) {
  return {
    focusMinutes: positive(settings.focusMinutes, POMODORO_DEFAULTS.focusMinutes, 240),
    breakMinutes: positive(settings.breakMinutes, POMODORO_DEFAULTS.breakMinutes, 120),
    longBreakMinutes: positive(settings.longBreakMinutes, POMODORO_DEFAULTS.longBreakMinutes, 240),
    longBreakEvery: Math.round(positive(settings.longBreakEvery, POMODORO_DEFAULTS.longBreakEvery, 12)),
    autoStart: settings.autoStart !== false,
  };
}

class TimeKeeper extends EventEmitter {
  constructor({ now = Date.now, pomodoro = {} } = {}) {
    super();
    this.now = now;
    this.timer = { duration: 0, remaining: 0, endsAt: null, label: '' };
    this.stopwatch = { elapsed: 0, startedAt: null };
    this.pomodoro = { phase: null, round: 0, duration: 0, remaining: 0, endsAt: null, settings: pomodoroSettings(pomodoro) };
    this.wakeTimer = null;
  }

  // -------------------------------------------------------------- timer

  startTimer(ms, label = '') {
    const duration = Math.round(Number(ms));
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('invalid duration');
    this.timer = { duration, remaining: duration, endsAt: this.now() + duration, label: String(label || '').slice(0, 80) };
    this.changed();
  }

  pauseTimer() {
    const timer = this.timer;
    if (!timer.endsAt) return;
    timer.remaining = Math.max(0, timer.endsAt - this.now());
    timer.endsAt = null;
    this.changed();
  }

  resumeTimer() {
    const timer = this.timer;
    if (timer.endsAt || timer.remaining <= 0) return;
    timer.endsAt = this.now() + timer.remaining;
    this.changed();
  }

  resetTimer() {
    this.timer = { ...this.timer, remaining: 0, endsAt: null };
    this.changed();
  }

  // -------------------------------------------------------------- stopwatch

  startStopwatch() {
    if (this.stopwatch.startedAt) return;
    this.stopwatch.startedAt = this.now();
    this.changed();
  }

  pauseStopwatch() {
    const sw = this.stopwatch;
    if (!sw.startedAt) return;
    sw.elapsed += this.now() - sw.startedAt;
    sw.startedAt = null;
    this.changed();
  }

  resetStopwatch() {
    this.stopwatch = { elapsed: 0, startedAt: null };
    this.changed();
  }

  // -------------------------------------------------------------- pomodoro

  setPomodoroSettings(settings) {
    this.pomodoro.settings = pomodoroSettings({ ...this.pomodoro.settings, ...settings });
    this.changed();
  }

  phaseLength(phase) {
    const s = this.pomodoro.settings;
    const minutes = phase === 'focus' ? s.focusMinutes : phase === 'longBreak' ? s.longBreakMinutes : s.breakMinutes;
    return Math.round(minutes * MINUTE);
  }

  enterPhase(phase, { run }) {
    const p = this.pomodoro;
    p.phase = phase;
    p.duration = this.phaseLength(phase);
    p.remaining = p.duration;
    p.endsAt = run ? this.now() + p.duration : null;
  }

  startPomodoro() {
    const p = this.pomodoro;
    if (p.phase && !p.endsAt && p.remaining > 0) return this.resumePomodoro();
    if (p.endsAt) return;
    p.round = 0;
    this.enterPhase('focus', { run: true });
    this.emit('pomodoro-phase', { from: null, to: 'focus', round: p.round });
    this.changed();
  }

  pausePomodoro() {
    const p = this.pomodoro;
    if (!p.endsAt) return;
    p.remaining = Math.max(0, p.endsAt - this.now());
    p.endsAt = null;
    this.changed();
  }

  resumePomodoro() {
    const p = this.pomodoro;
    if (!p.phase || p.endsAt) return;
    p.endsAt = this.now() + (p.remaining > 0 ? p.remaining : this.phaseLength(p.phase));
    this.changed();
  }

  /** End the current phase now and move on (focus → break, break → focus). */
  skipPomodoro() {
    if (!this.pomodoro.phase) return;
    this.advancePomodoro({ run: Boolean(this.pomodoro.endsAt) || this.pomodoro.settings.autoStart });
  }

  stopPomodoro() {
    const p = this.pomodoro;
    if (!p.phase) return;
    const from = p.phase;
    this.pomodoro = { ...p, phase: null, round: 0, duration: 0, remaining: 0, endsAt: null };
    this.emit('pomodoro-phase', { from, to: null, round: 0 });
    this.changed();
  }

  advancePomodoro({ run }) {
    const p = this.pomodoro;
    const from = p.phase;
    let to = 'focus';
    if (from === 'focus') {
      p.round += 1;
      to = p.round % p.settings.longBreakEvery === 0 ? 'longBreak' : 'break';
    }
    this.enterPhase(to, { run });
    this.emit('pomodoro-phase', { from, to, round: p.round });
    this.changed();
  }

  /** True while a focus phase is counting down. */
  isFocusing() {
    return this.pomodoro.phase === 'focus' && Boolean(this.pomodoro.endsAt);
  }

  // -------------------------------------------------------------- clock

  check() {
    const now = this.now();
    if (this.timer.endsAt && this.timer.endsAt <= now) {
      const { label, duration } = this.timer;
      this.timer = { ...this.timer, remaining: 0, endsAt: null };
      this.emit('timer-done', { label, duration });
      this.changed();
    }
    if (this.pomodoro.endsAt && this.pomodoro.endsAt <= now) {
      this.advancePomodoro({ run: this.pomodoro.settings.autoStart });
    }
  }

  schedule() {
    clearTimeout(this.wakeTimer);
    const next = [this.timer.endsAt, this.pomodoro.endsAt].filter(Boolean).sort((a, b) => a - b)[0];
    if (!next) return;
    this.wakeTimer = setTimeout(() => this.check(), Math.max(0, next - this.now()) + 25);
    if (this.wakeTimer.unref) this.wakeTimer.unref();
  }

  changed() {
    this.schedule();
    this.emit('change');
  }

  snapshot() {
    return {
      now: this.now(),
      timer: { ...this.timer },
      stopwatch: { ...this.stopwatch },
      pomodoro: { ...this.pomodoro, settings: { ...this.pomodoro.settings } },
    };
  }

  dispose() {
    clearTimeout(this.wakeTimer);
  }
}

module.exports = { TimeKeeper, pomodoroSettings, POMODORO_DEFAULTS };
