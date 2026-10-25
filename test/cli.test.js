'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { freePort, tempDir } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'claude-pet.js');

async function slashHook(input) {
  const port = await freePort(); // nothing listens here, so the pet counts as not running
  const result = spawnSync(process.execPath, [CLI, 'slash-hook'], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_PET_PORT: String(port), CLAUDE_PET_HOME: tempDir() },
  });
  return { status: result.status, stdout: result.stdout.toString() };
}

test('/pet list is answered by the hook and blocks the expansion', async () => {
  const { status, stdout } = await slashHook({
    hook_event_name: 'UserPromptExpansion',
    command_name: 'pet',
    command_args: 'list',
  });
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /mochi/);
});

test('/pet hide when the pet is not running says so', async () => {
  const { stdout } = await slashHook({ command_name: 'pet', command_args: 'hide' });
  assert.match(JSON.parse(stdout).reason, /起動していません/);
});

test('other slash commands pass through untouched', async () => {
  const { status, stdout } = await slashHook({ command_name: 'hatch-pet', command_args: '' });
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('help prints usage', () => {
  const result = spawnSync(process.execPath, [CLI, 'help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout.toString(), /claude-pet setup/);
});

test('/pet memo works without the pet running and keeps the project', async () => {
  const fs = require('fs');
  const home = tempDir();
  const port = await freePort();
  const result = spawnSync(process.execPath, [CLI, 'slash-hook'], {
    input: JSON.stringify({ command_name: 'pet', command_args: 'memo write the release notes', cwd: '/work/my-app' }),
    env: { ...process.env, CLAUDE_PET_PORT: String(port), CLAUDE_PET_HOME: home },
  });
  assert.match(JSON.parse(result.stdout.toString()).reason, /メモしました/);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'memos.json'), 'utf8')).memos;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, 'write the release notes');
  assert.equal(saved[0].project, 'my-app');
});

test('/pet timer and /pet dnd reject times they cannot read', async () => {
  const timer = await slashHook({ command_name: 'pet', command_args: 'timer soon' });
  assert.match(JSON.parse(timer.stdout).reason, /時間の書き方/);
  const dnd = await slashHook({ command_name: 'pet', command_args: 'dnd later' });
  assert.match(JSON.parse(dnd.stdout).reason, /時間の書き方/);
  const memo = await slashHook({ command_name: 'pet', command_args: 'memo' });
  assert.match(JSON.parse(memo.stdout).reason, /メモの内容/);
});
