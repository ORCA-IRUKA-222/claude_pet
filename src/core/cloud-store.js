'use strict';

// Cloud sessions have no transcript on this computer, so the pet remembers what the relay
// told it about them (~/.claude-pet/cloud-sessions.json). They stay in the list after the
// pet restarts, and the relay resumes after the last message it saw.

const fs = require('fs');
const path = require('path');
const { homeDir } = require('../shared/config');

const KEEP = 40;
const MAX_AGE_MS = 14 * 24 * 3600e3;
const FIELDS = ['id', 'cwd', 'title', 'prompt', 'firstPrompt', 'message', 'url', 'updatedAt', 'messages'];
const KEEP_MESSAGES = 20; // per session: the exchanges the relay carried, to show in the pet
const KEEP_CHARS = 30000;

function storeFile() {
  return path.join(homeDir(), 'cloud-sessions.json');
}

/** { sessions, lastId } — recent cloud sessions, newest first. */
function loadCloudSessions({ now = Date.now() } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    const sessions = (Array.isArray(data.sessions) ? data.sessions : []).filter(
      (s) => s && typeof s.id === 'string' && typeof s.url === 'string' && now - Number(s.updatedAt) <= MAX_AGE_MS,
    );
    return { sessions, lastId: typeof data.lastId === 'string' ? data.lastId : null };
  } catch {
    return { sessions: [], lastId: null };
  }
}

/** Save the cloud sessions in the list (the ones that link to claude.ai) and the relay position. */
function saveCloudSessions(sessions, lastId, { now = Date.now() } = {}) {
  const keep = sessions
    .filter((s) => s.source === 'cloud' && s.url && now - s.updatedAt <= MAX_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, KEEP)
    .map((s) => ({
      ...Object.fromEntries(FIELDS.map((k) => [k, s[k] ?? null])),
      messages: (Array.isArray(s.messages) ? s.messages : [])
        .slice(-KEEP_MESSAGES)
        .map((m) => ({ role: m.role, text: String(m.text || '').slice(0, KEEP_CHARS) })),
    }));
  const text = JSON.stringify({ lastId: lastId || null, sessions: keep }, null, 2) + '\n';
  // called after every change in the list; most of them aren't about cloud sessions
  try {
    if (fs.readFileSync(storeFile(), 'utf8') === text) return false;
  } catch {
    // first save
  }
  fs.mkdirSync(homeDir(), { recursive: true });
  const tmp = `${storeFile()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, storeFile());
  return true;
}

module.exports = { loadCloudSessions, saveCloudSessions, storeFile };
