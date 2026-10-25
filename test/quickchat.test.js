'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { QuickChat, buildArgs, parseLine, validAttachments, withAttachments } = require('../src/core/quickchat');
const { tempDir } = require('./helpers');

test('buildArgs validates everything that reaches the command line', () => {
  assert.deepEqual(buildArgs({}), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(buildArgs({ resume: '0a1b2c3d-4e5f-6789-abcd-ef0123456789' }).slice(-2), [
    '--resume',
    '0a1b2c3d-4e5f-6789-abcd-ef0123456789',
  ]);
  assert.throws(() => buildArgs({ resume: 'abc; rm -rf /' }), /session/);
  assert.throws(() => buildArgs({ permissionMode: 'yolo' }), /permission/);
  assert.throws(() => buildArgs({ model: 'opus && whoami' }), /model/);
});

test('parseLine turns stream-json into UI events', () => {
  assert.deepEqual(parseLine('{"type":"system","subtype":"init","session_id":"s-1"}'), [{ type: 'session', sessionId: 's-1' }]);
  assert.deepEqual(
    parseLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 's-1',
        message: {
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'tool_use', name: 'Read', input: {} },
          ],
        },
      }),
    ),
    [
      { type: 'session', sessionId: 's-1' },
      { type: 'text', text: 'Hi' },
      { type: 'tool', name: 'Read' },
    ],
  );
  assert.deepEqual(parseLine('{"type":"result","result":"Hi","is_error":false}'), [
    { type: 'result', text: 'Hi', isError: false },
  ]);
  assert.deepEqual(parseLine('garbage'), []);
});

function fakeClaude() {
  const dir = tempDir();
  const file = path.join(dir, 'claude');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const resumed = process.argv.includes('--resume');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: '11111111-2222-3333-4444-555555555555' });
  out({ type: 'assistant', session_id: '11111111-2222-3333-4444-555555555555', message: { content: [{ type: 'text', text: (resumed ? 'again: ' : 'echo: ') + input + ' / ' + process.env.CLAUDE_PET_SOURCE }] } });
  out({ type: 'result', result: 'done', is_error: false, session_id: '11111111-2222-3333-4444-555555555555' });
});
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function collect(chat) {
  return new Promise((resolve) => {
    const events = [];
    chat.on('event', function onEvent(ev) {
      events.push(ev);
      if (ev.type === 'done') {
        chat.off('event', onEvent);
        resolve(events);
      }
    });
  });
}

test('QuickChat streams a reply and resumes the same session', { skip: process.platform === 'win32' }, async () => {
  const chat = new QuickChat({ claudePath: fakeClaude() });
  const cwd = tempDir();

  let pending = collect(chat);
  chat.send({ prompt: 'hello', cwd });
  let events = await pending;
  assert.equal(events.find((e) => e.type === 'session').sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(events.find((e) => e.type === 'text').text, 'echo: hello / quickchat');
  assert.equal(events.at(-1).cwd, cwd);
  assert.equal(chat.busy, false);

  pending = collect(chat);
  chat.send({ prompt: 'more', cwd, resume: '11111111-2222-3333-4444-555555555555' });
  events = await pending;
  assert.equal(events.find((e) => e.type === 'text').text, 'again: more / quickchat');
});

test('QuickChat reports a missing claude binary', async () => {
  const chat = new QuickChat({ claudePath: path.join(tempDir(), 'no-such-claude') });
  const pending = collect(chat);
  chat.send({ prompt: 'hello' });
  const events = await pending;
  assert.ok(events.some((e) => e.type === 'error'));
});

test('attachments: only existing absolute paths, listed in the prompt with their folders allowed', () => {
  const dir = tempDir();
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, 'png');
  const files = validAttachments([file, file, 'relative.txt', path.join(dir, 'missing.txt'), 42]);
  assert.deepEqual(files, [file]);
  assert.deepEqual(validAttachments([path.join(dir, 'a"b.txt')], { platform: 'win32' }), []);

  const { prompt, addDirs } = withAttachments('What is this?', files, '添付ファイル');
  assert.equal(prompt, `What is this?\n\n添付ファイル:\n- ${file}`);
  assert.deepEqual(addDirs, [dir]);
  assert.deepEqual(buildArgs({ addDirs }).slice(-2), ['--add-dir', dir]);
  assert.throws(() => buildArgs({ addDirs: ['relative'] }), /folder/);
  assert.deepEqual(withAttachments('hi', []), { prompt: 'hi', addDirs: [] });
});
