'use strict';

// Notifications from other apps (Discord, …) on Windows, so the pet can say them.
//
// Windows keeps every toast in a SQLite database (WpnService):
//   %LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db
//     Notification        Id, HandlerId, Type ('toast'), Payload (toast XML), ArrivalTime (FILETIME)
//     NotificationHandler RecordId, PrimaryId (the app's AppUserModelID, e.g. com.squirrel.Discord.Discord)
// It is not a documented interface, and it is held open by Windows, so it is read from a
// private copy. Banners can be switched off for an app in Windows' settings while the
// notification still reaches the notification center (and so this database).
// Nothing is stored or sent anywhere: a notification is read, shown once and forgotten.

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILETIME_EPOCH_MS = 11644473600000; // 1601-01-01 → 1970-01-01
const COPY_SUFFIXES = ['', '-wal', '-shm'];

function dbPath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
}

/**
 * FILETIME (100 ns ticks since 1601) → epoch ms. Real values are about 1.3e17, more than a
 * JavaScript number holds exactly (2^53), so they are kept as BigInt until they are divided down.
 */
function fromFiletime(ticks) {
  let big;
  try {
    big = typeof ticks === 'bigint' ? ticks : BigInt(Math.trunc(Number(ticks)));
  } catch {
    return 0;
  }
  if (big <= 0n) return 0;
  return Number(big / 10000n) - FILETIME_EPOCH_MS;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Toast XML (a string or the BLOB's bytes) → { title, body } from its <text> elements. */
function parsePayload(payload) {
  let xml = '';
  if (typeof payload === 'string') xml = payload;
  else if (payload && payload.length != null) {
    const bytes = Buffer.from(payload);
    // toasts are UTF-8; some writers use UTF-16 with a byte order mark
    xml = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8');
  }
  xml = xml.replace(/^\uFEFF/, '');
  const texts = [];
  const re = /<text\b[^>]*?(?:\/>|>([\s\S]*?)<\/text>)/gi;
  let m;
  while ((m = re.exec(xml))) {
    const value = decodeEntities((m[1] || '').replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (value) texts.push(value);
  }
  return { title: texts[0] || '', body: texts.slice(1).join('\n') };
}

/**
 * A name for an app from its AppUserModelID:
 *   com.squirrel.Discord.Discord → Discord, Microsoft.WindowsStore_8wekyb3d8bbwe!App → WindowsStore,
 *   C:\Program Files\LINE\LINE.exe → LINE
 */
function appName(primaryId) {
  let id = String(primaryId || '').trim();
  if (!id) return '';
  const exe = /([^\\/]+?)(?:\.exe)?$/i.exec(id.split('!')[0]);
  if (/[\\/]/.test(id) && exe) return exe[1];
  id = id.split('!')[0].replace(/_[a-z0-9]{13}$/i, '');
  const parts = id.split('.').filter(Boolean);
  return parts[parts.length - 1] || id;
}

/** Does the app match one of the user's names (case-insensitive, on the id or the shown name)? */
function wanted(primaryId, apps) {
  if (!Array.isArray(apps) || !apps.length) return false;
  const hay = `${primaryId}\n${appName(primaryId)}`.toLowerCase();
  return apps.some((a) => typeof a === 'string' && a.trim() && hay.includes(a.trim().toLowerCase()));
}

/** AppUserModelIDs are made of these; anything else is never handed to the shell. */
const SAFE_APP_ID = /^[\w.!{}()\\ -]{1,260}$/;

function copyDatabase(file, dir) {
  const target = path.join(dir, 'wpn.db');
  for (const suffix of COPY_SUFFIXES) {
    const from = file + suffix;
    const to = target + suffix;
    try {
      fs.copyFileSync(from, to);
    } catch (err) {
      // the main file is required; -wal / -shm may not exist
      if (suffix === '') throw new Error(`通知のデータベースを読めません（${err.code || err.message}）: ${from}`);
    }
  }
  return target;
}

function signature(file) {
  return COPY_SUFFIXES.map((s) => {
    try {
      const st = fs.statSync(file + s);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '-';
    }
  }).join('|');
}

function openSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    throw new Error('この Node.js には SQLite がありません（Node.js 22.13 以上が必要です）');
  }
}

function columnsOf(db, table) {
  try {
    return db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * Read the notifications that arrived after `since` (FILETIME ticks), oldest first.
 * Column names are looked up, so a Windows that names them a little differently fails with
 * a message that says what was found instead.
 */
function readNotifications(db, since = 0n) {
  const n = columnsOf(db, 'Notification');
  const h = columnsOf(db, 'NotificationHandler');
  const need = (cols, list, table) => {
    const missing = list.filter((c) => !cols.includes(c));
    if (missing.length)
      throw new Error(`${table} テーブルに ${missing.join(', ')} 列がありません（見つかった列: ${cols.join(', ') || 'なし'}）`);
  };
  need(n, ['Id', 'HandlerId', 'Payload', 'ArrivalTime'], 'Notification');
  need(h, ['RecordId', 'PrimaryId'], 'NotificationHandler');
  const typed = n.includes('Type');
  const query = db.prepare(
    `SELECT n.Id AS id, n.Payload AS payload, n.ArrivalTime AS arrival, ${typed ? 'n.Type' : "'toast'"} AS type, h.PrimaryId AS app
       FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
       WHERE n.ArrivalTime > ? ORDER BY n.ArrivalTime ASC LIMIT 200`,
  );
  query.setReadBigInts(true); // ArrivalTime does not fit in a number
  return query
    .all(BigInt(since))
    .filter((r) => !typed || String(r.type || '').toLowerCase() === 'toast')
    .map((r) => ({ id: Number(r.id), app: String(r.app || ''), arrival: BigInt(r.arrival), ...parsePayload(r.payload) }));
}

/** Newest FILETIME in the database (what "already seen" starts from). */
function newestArrival(db) {
  try {
    const query = db.prepare('SELECT MAX(ArrivalTime) AS t FROM Notification');
    query.setReadBigInts(true);
    const row = query.get();
    return row && row.t != null ? BigInt(row.t) : 0n;
  } catch {
    return 0n;
  }
}

class NoticeWatcher extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.file]        the database (default: the Windows one)
   * @param {() => string[]} opts.apps  names of the apps to pass on (read at every check)
   * @param {number} [opts.intervalMs]
   */
  constructor({ file = dbPath(), apps = () => [], intervalMs = 2500 } = {}) {
    super();
    this.file = file;
    this.apps = apps;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.since = null; // FILETIME of the newest notification seen
    this.signature = '';
    this.busy = false;
    this.error = null;
  }

  /** Open a private copy, run `fn(db)`, clean up. */
  withDb(fn) {
    const { DatabaseSync } = openSqlite();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-wpn-'));
    let db = null;
    try {
      // the copy is thrown away, so it is opened normally (a read-only handle can't use a WAL file)
      db = new DatabaseSync(copyDatabase(this.file, dir));
      return fn(db);
    } finally {
      try {
        if (db) db.close();
      } catch {
        // already closed
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** One look at the database. Only notifications that arrived since the last look are passed on. */
  check() {
    if (this.busy) return [];
    this.busy = true;
    try {
      const sig = signature(this.file);
      if (this.since !== null && sig === this.signature) return []; // nothing was written
      const fresh = this.withDb((db) => {
        if (this.since === null) {
          // the first look only remembers where we are: what arrived earlier is not replayed
          this.since = newestArrival(db);
          return [];
        }
        return readNotifications(db, this.since);
      });
      this.signature = sig;
      this.error = null;
      const out = [];
      for (const item of fresh) {
        if (item.arrival > this.since) this.since = item.arrival;
        if (!wanted(item.app, this.apps())) continue;
        if (!item.title && !item.body) continue;
        const notice = { ...item, appName: appName(item.app), arrivedAt: fromFiletime(item.arrival) };
        out.push(notice);
        this.emit('notice', notice);
      }
      return out;
    } catch (err) {
      if (!this.error || this.error.message !== err.message) this.emit('error', err);
      this.error = err;
      return [];
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return;
    this.since = null;
    this.signature = '';
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * What is wrong (or right) with reading the database, for `claude-pet notices doctor`.
 * Titles and texts are left out unless `showText` is set.
 */
function diagnose({ file = dbPath(), showText = false, platform = process.platform } = {}) {
  const report = { file, platform, ok: false, steps: [], recent: [] };
  const step = (name, ok, detail = '') => report.steps.push({ name, ok, detail });
  if (platform !== 'win32') {
    step('Windows', false, 'この機能は Windows 用です');
    return report;
  }
  step('Windows', true);
  if (!fs.existsSync(file)) {
    step('通知のデータベース', false, `${file} が見つかりません`);
    return report;
  }
  step('通知のデータベース', true, file);
  const watcher = new NoticeWatcher({ file });
  try {
    watcher.withDb((db) => {
      step('コピーして開く', true);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      step('テーブル', tables.includes('Notification') && tables.includes('NotificationHandler'), tables.join(', '));
      const rows = readNotifications(db, 0n).slice(-8);
      step('通知を読む', true, `${rows.length} 件`);
      report.recent = rows.map((r) => ({
        app: r.app,
        name: appName(r.app),
        at: fromFiletime(r.arrival) ? new Date(fromFiletime(r.arrival)).toISOString() : '',
        title: showText ? r.title : undefined,
        body: showText ? r.body : undefined,
      }));
    });
    report.ok = report.steps.every((s) => s.ok);
  } catch (err) {
    step('読み取り', false, err.message);
  }
  return report;
}

module.exports = {
  NoticeWatcher,
  dbPath,
  fromFiletime,
  parsePayload,
  appName,
  wanted,
  readNotifications,
  newestArrival,
  diagnose,
  SAFE_APP_ID,
};
