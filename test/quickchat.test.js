'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { QuickChat, buildArgs, buildCloudArgs, modelArgs, parseLine, decodeOutput } = require('../src/core/quickchat');
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

test('QuickChat says so when no claude command was found', () => {
  const chat = new QuickChat({ claudePath: () => null });
  assert.throws(
    () => chat.send({ prompt: 'hello' }),
    (err) => err.code === 'CLAUDE_NOT_FOUND',
  );
  assert.equal(chat.busy, false);
});

test('error output from cmd.exe on Japanese Windows is readable', () => {
  const sjis = Buffer.from([
    0x27, 0x63, 0x6c, 0x61, 0x75, 0x64, 0x65, 0x27, 0x20, 0x82, 0xcd, 0x81, 0x41, 0x93, 0xe0, 0x95, 0x94,
  ]);
  assert.equal(decodeOutput(sjis, 'win32'), "'claude' は、内部");
  assert.equal(decodeOutput(Buffer.from('エラー'), 'win32'), 'エラー');
});

/** A claude that answers cloud tasks: it refuses stream-json, then replies in plain text. */
function fakeCloudClaude() {
  const file = path.join(tempDir(), 'claude');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (args.includes('stream-json')) {
    process.stderr.write('Error: claude -p --cloud does not support --output-format stream-json\\n');
    process.exit(1);
  }
  const attach = args[args.indexOf('--cloud') + 1];
  process.stderr.write('Creating cloud session…\\n');
  process.stderr.write('Cloud session: cse_01ABC (https://claude.ai/code/session_01ABC)\\n');
  process.stdout.write((attach ? 'follow-up to ' + attach : 'task') + ': ' + input + '\\n\\nsecond line\\n');
});
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

test('cloud tasks start a cloud session, or attach to one for a follow-up', () => {
  assert.deepEqual(buildCloudArgs({}), ['-p', '--cloud', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(buildCloudArgs({ text: true }), ['-p', '--cloud']);
  assert.deepEqual(buildCloudArgs({ resume: 'cse_01ABC' }), ['-p', '--cloud', 'cse_01ABC']);
  assert.throws(() => buildCloudArgs({ resume: '--dangerously-skip-permissions' }), /invalid/);
});

test(
  'a cloud task reports its session and reply, falling back to plain text',
  { skip: process.platform === 'win32' },
  async () => {
    const chat = new QuickChat({ claudePath: fakeCloudClaude() });
    let pending = collect(chat);
    chat.send({ prompt: 'アプリを作って', cwd: tempDir(), cloud: true });
    let events = await pending;
    assert.deepEqual(
      events.find((e) => e.type === 'cloud'),
      {
        type: 'cloud',
        cloudSessionId: 'cse_01ABC',
        url: 'https://claude.ai/code/session_01ABC',
      },
    );
    assert.ok(events.some((e) => e.type === 'note' && e.text === 'Creating cloud session…'));
    const reply = events.filter((e) => e.type === 'raw').map((e) => e.text);
    assert.deepEqual(reply, ['task: アプリを作って', '', 'second line']);
    assert.ok(!events.some((e) => e.type === 'error'), 'the stream-json refusal is retried, not shown');
    assert.equal(events.filter((e) => e.type === 'done').length, 1);

    pending = collect(chat);
    chat.send({ prompt: '続けて', cwd: tempDir(), cloud: true, resume: 'cse_01ABC' });
    events = await pending;
    assert.equal(events.find((e) => e.type === 'raw').text, 'follow-up to cse_01ABC: 続けて');
  },
);

test(
  'a Claude Code that starts cloud sessions only interactively hands the task back',
  { skip: process.platform === 'win32' },
  async () => {
    const file = path.join(tempDir(), 'claude');
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('Error: --cloud cannot be combined with --print. Starting a new cloud session with --cloud is interactive only\\n');
  process.exit(1);
});
`,
    );
    fs.chmodSync(file, 0o755);
    const chat = new QuickChat({ claudePath: file });
    const pending = collect(chat);
    const dir = tempDir();
    chat.send({ prompt: 'ピン止めを直して', cwd: dir, cloud: true });
    const events = await pending;
    assert.deepEqual(
      events.find((e) => e.type === 'interactive-only'),
      { type: 'interactive-only', prompt: 'ピン止めを直して', cwd: dir },
    );
    assert.ok(!events.some((e) => e.type === 'error'));
  },
);

test('model and effort go on every run; unknown values are refused', () => {
  assert.deepEqual(modelArgs({ model: 'claude-opus-5-5', effort: 'xhigh' }), ['--model', 'claude-opus-5-5', '--effort', 'xhigh']);
  assert.deepEqual(buildArgs({ model: 'opus', effort: 'max' }).slice(-4), ['--model', 'opus', '--effort', 'max']);
  assert.deepEqual(buildCloudArgs({ text: true, model: 'opus', effort: 'high' }), [
    '-p',
    '--cloud',
    '--model',
    'opus',
    '--effort',
    'high',
  ]);
  assert.throws(() => modelArgs({ effort: 'turbo' }), /invalid effort/);
  assert.throws(() => modelArgs({ model: 'opus; rm -rf' }), /invalid model/);
});

test('a Claude Code without --effort is asked again without it', { skip: process.platform === 'win32' }, async () => {
  const file = path.join(tempDir(), 'claude');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  if (process.argv.includes('--effort')) {
    process.stderr.write("error: unknown option '--effort'\\n");
    process.exit(1);
  }
  const model = process.argv[process.argv.indexOf('--model') + 1];
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'model=' + model }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', result: 'ok', is_error: false }) + '\\n');
});
`,
  );
  fs.chmodSync(file, 0o755);
  const chat = new QuickChat({ claudePath: file, model: 'claude-opus-5-5', effort: 'xhigh' });
  const events = await new Promise((resolve) => {
    const all = [];
    chat.on('event', (ev) => {
      all.push(ev);
      if (ev.type === 'done') resolve(all);
    });
    chat.send({ prompt: 'hi', cwd: tempDir() });
  });
  assert.equal(events.find((e) => e.type === 'text').text, 'model=claude-opus-5-5');
  assert.ok(!events.some((e) => e.type === 'error'));
  assert.equal(chat.noEffort, true);
});
