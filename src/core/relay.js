'use strict';

// Listens on the ntfy topic that cloud sessions publish to (see src/hook/cloud-hook.js),
// decrypts each message and emits it as a hook event. Reconnects with backoff and resumes
// after the last message it saw, so events sent while the computer slept still arrive
// (ntfy keeps messages for 12 hours).

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { unseal } = require('../shared/seal');

const SILENCE_MS = 2 * 60e3; // ntfy sends a keepalive every 45 seconds

class RelayListener extends EventEmitter {
  constructor({ server = 'https://ntfy.sh', topic, key, since = '12h', lastId = null }) {
    super();
    this.server = String(server).replace(/\/+$/, '');
    this.topic = topic;
    this.key = key;
    this.since = since;
    this.lastId = lastId; // resume after this message (ntfy keeps 12 hours)
    this.retry = 0;
    this.conn = null;
    this.timer = null;
    this.watchdog = null;
    this.status = 'stopped';
    this.stopped = true;
    this.parts = new Map(); // long events arrive compressed in parts: id → { n, got, count, at }
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    if (this.conn) this.conn.req.destroy();
    this.conn = null;
    this.setStatus('stopped');
  }

  setStatus(status, detail) {
    if (status === this.status) return;
    this.status = status;
    this.emit('status', status, detail);
  }

  connect() {
    const url = new URL(`${this.server}/${this.topic}/json`);
    url.searchParams.set('since', this.lastId || this.since);
    const conn = {};
    this.conn = conn;
    const current = () => this.conn === conn && !this.stopped;
    conn.req = (url.protocol === 'http:' ? http : https).get(url, { headers: { 'user-agent': 'claude-pet' } }, (res) => {
      if (!current()) return res.resume();
      if (res.statusCode !== 200) {
        res.resume();
        return this.reconnect(conn, `HTTP ${res.statusCode}`);
      }
      this.retry = 0;
      this.setStatus('connected');
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (!current()) return;
        this.alive(conn);
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          this.line(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      res.on('end', () => this.reconnect(conn, 'closed'));
      res.on('error', (err) => this.reconnect(conn, err.message));
    });
    conn.req.on('error', (err) => this.reconnect(conn, err.message));
    this.alive(conn);
  }

  alive(conn) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.reconnect(conn, 'no keepalive'), SILENCE_MS);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  line(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || msg.event !== 'message') return;
    if (msg.id) this.lastId = msg.id;
    const event = unseal(msg.message, this.key);
    if (event && typeof event === 'object' && event.part) this.addPart(event);
    else if (event && typeof event === 'object' && typeof event.session_id === 'string') this.emit('event', event);
  }

  /** Collect the parts of a long event; once all are here, unpack it and pass it on. */
  addPart({ part, z }) {
    const { id, i, n } = part || {};
    if (typeof id !== 'string' || !Number.isInteger(n) || n < 1 || n > 500 || !Number.isInteger(i) || i < 0 || i >= n) return;
    if (typeof z !== 'string') return;
    const now = Date.now();
    for (const [key, entry] of this.parts) if (now - entry.at > 10 * 60e3) this.parts.delete(key);
    let entry = this.parts.get(id);
    if (!entry) {
      entry = { n, got: new Array(n), count: 0, at: now };
      this.parts.set(id, entry);
    }
    if (entry.n !== n || entry.got[i]) return;
    entry.got[i] = Buffer.from(z, 'base64');
    if (++entry.count < n) return;
    this.parts.delete(id);
    try {
      const json = zlib.inflateRawSync(Buffer.concat(entry.got), { maxOutputLength: 2 * 1024 * 1024 }).toString('utf8');
      const event = JSON.parse(json);
      if (event && typeof event.session_id === 'string') this.emit('event', event);
    } catch {
      // damaged or incomplete
    }
  }

  reconnect(conn, reason) {
    if (this.conn !== conn || this.stopped) return;
    this.conn = null;
    conn.req.destroy();
    clearTimeout(this.watchdog);
    this.setStatus('disconnected', reason);
    const delay = Math.min(60e3, 2000 * 2 ** this.retry++);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
    if (this.timer.unref) this.timer.unref();
  }
}

/** Publish one sealed message (used by `claude-pet cloud test`). */
function publish({ server = 'https://ntfy.sh', topic }, body, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${String(server).replace(/\/+$/, '')}/${topic}`);
    const req = (url.protocol === 'http:' ? http : https).request(
      url,
      { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': 'claude-pet' }, timeout },
      (res) => {
        res.resume();
        res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { RelayListener, publish };
