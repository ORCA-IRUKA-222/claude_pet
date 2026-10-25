'use strict';

// Quiet modes and "while you were away" digests.
//   dnd    おやすみモード: hides bubbles and notifications until a time (or until turned off);
//          requests for input can still get through.
//   focus  a pomodoro focus phase: finished work is held back, requests for input are not.
//   away   the user isn't at the computer. Nothing is held, but what happened is counted
//          so the pet can sum it up when they come back.

const { EventEmitter } = require('events');

const ATTENTION = ['ready', 'waiting', 'failed'];

function emptyCounts() {
  return { ready: 0, waiting: 0, failed: 0 };
}

class Modes extends EventEmitter {
  constructor({ now = Date.now, dnd = null } = {}) {
    super();
    this.now = now;
    this.dnd = null;
    this.focus = false;
    this.away = false;
    this.digests = new Map(); // reason → { since, counts }
    this.expiryTimer = null;
    if (dnd && dnd.active && (dnd.until == null || dnd.until > now())) {
      this.setDnd({ until: dnd.until ?? null, allowWaiting: dnd.allowWaiting !== false });
    }
  }

  /** Turn おやすみモード on: `until` is a timestamp, or null to stay on until turned off. */
  setDnd({ until = null, allowWaiting = true } = {}) {
    const wasOn = Boolean(this.dnd);
    this.dnd = { until: until == null ? null : Number(until), allowWaiting: Boolean(allowWaiting) };
    if (!wasOn) this.begin('dnd');
    this.scheduleExpiry();
    this.emit('change');
  }

  setDndAllowWaiting(allowWaiting) {
    if (!this.dnd) return;
    this.dnd.allowWaiting = Boolean(allowWaiting);
    this.emit('change');
  }

  clearDnd() {
    if (!this.dnd) return;
    this.dnd = null;
    clearTimeout(this.expiryTimer);
    this.end('dnd');
    this.emit('change');
  }

  dndActive() {
    if (this.dnd && this.dnd.until != null && this.dnd.until <= this.now()) this.clearDnd();
    return Boolean(this.dnd);
  }

  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    if (!this.dnd || this.dnd.until == null) return;
    this.expiryTimer = setTimeout(() => this.dndActive(), Math.max(0, this.dnd.until - this.now()) + 25);
    if (this.expiryTimer.unref) this.expiryTimer.unref();
  }

  setFocus(focus) {
    if (this.focus === Boolean(focus)) return;
    this.focus = Boolean(focus);
    if (this.focus) this.begin('focus');
    else this.end('focus');
    this.emit('change');
  }

  setAway(away) {
    if (this.away === Boolean(away)) return;
    this.away = Boolean(away);
    if (this.away) this.begin('away');
    else this.end('away');
    this.emit('change');
  }

  /** Should a transition to `status` be kept out of the bubble and notifications for now? */
  holds(status) {
    if (!ATTENTION.includes(status)) return false;
    const dnd = this.dndActive();
    if (status === 'waiting') return dnd && !this.dnd.allowWaiting;
    return dnd || this.focus;
  }

  /** Count a status change in every open digest. */
  record(status) {
    if (!ATTENTION.includes(status)) return;
    for (const digest of this.digests.values()) digest.counts[status] += 1;
  }

  begin(reason) {
    this.digests.set(reason, { since: this.now(), counts: emptyCounts() });
  }

  end(reason) {
    const digest = this.digests.get(reason);
    if (!digest) return;
    this.digests.delete(reason);
    this.emit('digest', { reason, since: digest.since, duration: this.now() - digest.since, counts: digest.counts });
  }

  snapshot() {
    const dnd = this.dndActive() ? { ...this.dnd } : null;
    return { dnd, focus: this.focus, away: this.away };
  }

  /** What to keep in config.json so おやすみモード survives a restart. */
  persisted() {
    return this.dnd
      ? { active: true, until: this.dnd.until, allowWaiting: this.dnd.allowWaiting }
      : { active: false, until: null, allowWaiting: true };
  }

  dispose() {
    clearTimeout(this.expiryTimer);
  }
}

module.exports = { Modes, emptyCounts };
