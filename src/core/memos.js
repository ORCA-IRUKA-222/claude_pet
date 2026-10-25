'use strict';

// Memos (with a checkbox, so they double as a to-do list), saved to
// ~/.claude-pet/memos.json. `/pet memo` adds one tagged with the project it
// was written in.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { homeDir } = require('../shared/config');

const MAX_TEXT = 4000;
const MAX_MEMOS = 500;

function memoFile() {
  return path.join(homeDir(), 'memos.json');
}

function readMemos(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.memos) ? data.memos.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string') : [];
  } catch {
    return [];
  }
}

class MemoStore {
  constructor({ file = memoFile(), now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.memos = readMemos(file);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ memos: this.memos }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  /** Open memos first (newest on top), then finished ones. */
  list() {
    return [...this.memos].sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
  }

  add({ text, cwd = null } = {}) {
    const body = String(text || '')
      .trim()
      .slice(0, MAX_TEXT);
    if (!body) throw new Error('empty memo');
    const now = this.now();
    const memo = {
      id: crypto.randomUUID(),
      text: body,
      done: false,
      cwd: cwd ? String(cwd) : null,
      project: cwd ? path.basename(String(cwd)) : null,
      createdAt: now,
      updatedAt: now,
    };
    this.memos.push(memo);
    if (this.memos.length > MAX_MEMOS) {
      // Drop the oldest finished memos first, then the oldest open ones.
      const drop = this.list()
        .reverse()
        .slice(0, this.memos.length - MAX_MEMOS);
      this.memos = this.memos.filter((m) => !drop.includes(m));
    }
    this.save();
    return memo;
  }

  update(id, changes = {}) {
    const memo = this.memos.find((m) => m.id === id);
    if (!memo) return null;
    if (typeof changes.text === 'string') {
      const body = changes.text.trim().slice(0, MAX_TEXT);
      if (body) memo.text = body;
    }
    if (typeof changes.done === 'boolean') memo.done = changes.done;
    memo.updatedAt = this.now();
    this.save();
    return memo;
  }

  remove(id) {
    const before = this.memos.length;
    this.memos = this.memos.filter((m) => m.id !== id);
    if (this.memos.length === before) return false;
    this.save();
    return true;
  }

  clearDone() {
    const before = this.memos.length;
    this.memos = this.memos.filter((m) => !m.done);
    if (this.memos.length !== before) this.save();
    return before - this.memos.length;
  }
}

module.exports = { MemoStore, memoFile, MAX_TEXT };
