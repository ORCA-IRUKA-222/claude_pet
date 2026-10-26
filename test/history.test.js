'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

const claudeDir = tempDir();
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const { recentSessions, readSession, findTranscript, readConversation } = require('../src/core/history');
const { SessionTracker } = require('../src/core/sessions');

function writeTranscript(project, id, entries, mtime) {
  const dir = path.join(claudeDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify({ sessionId: id, ...e })).join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

const user = (content, extra = {}) => ({ type: 'user', cwd: '/w/app', message: { role: 'user', content }, ...extra });
const assistant = (content, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content }, ...extra });

test('readSession picks the last real prompt and the last reply', () => {
  const file = writeTranscript('-w-app', 'aaaa-1111', [
    user('ログイン画面のバグを直して', { origin: { kind: 'human' } }),
    assistant([
      { type: 'thinking', thinking: '...' },
      { type: 'text', text: '原因を調べます。' },
    ]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    user('<system-reminder>internal</system-reminder>'),
    user('[Image: original 100x100]'),
    assistant([{ type: 'text', text: 'サブエージェントの返事' }], { isSidechain: true }),
    assistant([{ type: 'text', text: '直しました。テストも通っています。' }]),
    { type: 'system', subtype: 'stop' },
  ]);
  const s = readSession(file);
  assert.equal(s.id, 'aaaa-1111');
  assert.equal(s.cwd, '/w/app');
  assert.equal(s.prompt, 'ログイン画面のバグを直して');
  assert.equal(s.message, '直しました。テストも通っています。');
});

test('prompts sent by tools or the system are not taken as the user prompt', () => {
  const file = writeTranscript('-w-app', 'bbbb-2222', [
    user('READMEを英訳して', { origin: { kind: 'human' } }),
    user('Stop hook feedback: uncommitted changes', { origin: { kind: 'hook' } }),
    assistant([{ type: 'text', text: '英訳しました。' }]),
  ]);
  assert.equal(readSession(file).prompt, 'READMEを英訳して');
});

test('recentSessions lists recent conversations newest first and skips old or empty ones', () => {
  const now = Date.now();
  writeTranscript('-w-old', 'cccc-3333', [user('昔の会話'), assistant([{ type: 'text', text: 'old' }])], now - 20 * 24 * 3600e3);
  writeTranscript('-w-empty', 'dddd-4444', [{ type: 'system', subtype: 'init' }], now - 60e3);
  writeTranscript('-w-new', 'eeee-5555', [user('最新の会話'), assistant([{ type: 'text', text: 'new' }])], now - 30e3);
  const list = recentSessions({ now });
  const ids = list.map((s) => s.id);
  assert.ok(
    list.every((s, i) => i === 0 || list[i - 1].updatedAt >= s.updatedAt),
    'newest first',
  );
  assert.ok(ids.includes('eeee-5555'));
  assert.ok(ids.includes('aaaa-1111'));
  assert.ok(!ids.includes('cccc-3333'), 'older than two weeks');
  assert.ok(!ids.includes('dddd-4444'), 'no conversation in it');
});

test('seeded history is idle, survives pruning, and never overwrites a live session', () => {
  let now = 1_000_000_000;
  const tracker = new SessionTracker({ now: () => now, expireMs: 3600e3 });
  tracker.handle({ session_id: 'live', cwd: '/w/live', event: 'UserPromptSubmit', ts: 1 });
  tracker.seed([
    { id: 'live', cwd: '/w/other', prompt: 'x', updatedAt: now - 10 },
    { id: 'past', cwd: '/w/past', prompt: '前の依頼', message: '前の返事', updatedAt: now - 5 * 3600e3 },
  ]);
  const past = tracker.list().find((s) => s.id === 'past');
  assert.equal(past.effectiveStatus, 'idle');
  assert.equal(past.project, 'past');
  assert.equal(past.message, '前の返事');
  assert.equal(tracker.list().find((s) => s.id === 'live').project, 'live');
  assert.equal(tracker.aggregate().status, 'running');

  now += 2 * 3600e3;
  tracker.prune();
  assert.ok(
    tracker.list().some((s) => s.id === 'past'),
    'history is kept past expireMs',
  );

  // the conversation went on without the hooks: the list catches up on the next reload
  tracker.seed([{ id: 'past', cwd: '/w/past', prompt: '続き', message: '続きの返事', updatedAt: now - 60e3 }]);
  const updated = tracker.list().find((s) => s.id === 'past');
  assert.equal(updated.message, '続きの返事');
  assert.equal(updated.firstPrompt, '前の依頼');

  tracker.handle({ session_id: 'past', cwd: '/w/past', event: 'UserPromptSubmit', ts: 2 });
  assert.equal(tracker.list().find((s) => s.id === 'past').history, false);
});

test('a past conversation reads back as user / assistant messages for the quick chat', () => {
  writeTranscript('-w-chat', 'ffff-6666', [
    user('READMEを直して', { origin: { kind: 'human' }, cwd: '/w/chat' }),
    assistant([
      { type: 'text', text: '確認します。' },
      { type: 'tool_use', id: 't', name: 'Read', input: {} },
    ]),
    user([{ type: 'tool_result', tool_use_id: 't', content: '...' }]),
    assistant([{ type: 'text', text: '直しました。' }]),
    assistant([{ type: 'text', text: '別の流れ' }], { isSidechain: true }),
    user('ありがとう', { origin: { kind: 'human' } }),
    assistant([{ type: 'text', text: 'どういたしまして。' }]),
  ]);
  const file = findTranscript('ffff-6666');
  assert.ok(file && file.endsWith('ffff-6666.jsonl'));
  assert.equal(findTranscript('../etc/passwd'), null);
  assert.equal(findTranscript('0000-0000-none'), null);
  const { cwd, messages } = readConversation(file);
  assert.equal(cwd, '/w/app');
  assert.deepEqual(messages, [
    { role: 'user', text: 'READMEを直して' },
    { role: 'assistant', text: '確認します。\n\n直しました。' },
    { role: 'user', text: 'ありがとう' },
    { role: 'assistant', text: 'どういたしまして。' },
  ]);
});

test('past `claude -p` runs come back as quick chats', () => {
  const tracker = new SessionTracker();
  tracker.seed([{ id: 'qc-0001', cwd: '/home/me', prompt: '今日は', entrypoint: 'sdk-cli', updatedAt: Date.now() }]);
  assert.equal(tracker.list()[0].source, 'quickchat');
});
