'use strict';

// Reads recent Claude Code conversations from ~/.claude/projects/*/<session>.jsonl so the
// pet can list sessions that happened before it started (or before the hooks were set up).

const fs = require('fs');
const path = require('path');
const { claudeDir } = require('../shared/config');

const TAIL_BYTES = 512 * 1024;
const NOISE = /^(\[Image[: ]|Stop hook feedback|Caveat:|<command-|<local-command|<system-reminder>|<bash-|<task-notification)/;

function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // drop a partial first line when we started mid-file
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function isHumanPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || !entry.message) return false;
  if (entry.origin && entry.origin.kind && entry.origin.kind !== 'human') return false;
  const content = entry.message.content;
  if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) return false;
  const text = textOf(content).trim();
  return Boolean(text) && !NOISE.test(text);
}

function clip(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Summarise one transcript file, or null if it holds no conversation. */
function readSession(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const session = {
    id: path.basename(file, '.jsonl'),
    cwd: null,
    prompt: null,
    message: null,
    title: null,
    updatedAt: stat.mtimeMs,
  };
  for (const line of readTail(file).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.sessionId && entry.sessionId !== session.id) continue;
    if (typeof entry.cwd === 'string') session.cwd = entry.cwd;
    if (entry.type === 'custom-title' && entry.customTitle) session.title = clip(entry.customTitle, 120);
    if (entry.type === 'last-prompt' && entry.lastPrompt) session.prompt = clip(entry.lastPrompt, 300);
    else if (isHumanPrompt(entry)) session.prompt = clip(textOf(entry.message.content), 300);
    if (entry.type === 'assistant' && !entry.isSidechain && entry.message) {
      const text = textOf(entry.message.content);
      if (text.trim()) session.message = clip(text, 4000);
    }
  }
  return session.prompt || session.message ? session : null;
}

/** Every transcript file with its modification time, newest first. */
function transcriptFiles() {
  const root = path.join(claudeDir(), 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, dir.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, dir.name, name);
      try {
        files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        // vanished while listing
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Recent sessions, newest first. */
function recentSessions({ maxAgeMs = 7 * 24 * 3600e3, limit = 20, now = Date.now() } = {}) {
  const sessions = [];
  for (const { file, mtimeMs } of transcriptFiles()) {
    if (now - mtimeMs > maxAgeMs) break;
    if (sessions.length >= limit) break;
    const s = readSession(file);
    if (s) sessions.push(s);
  }
  return sessions;
}

module.exports = { recentSessions, readSession, transcriptFiles, isHumanPrompt };
