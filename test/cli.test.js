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
