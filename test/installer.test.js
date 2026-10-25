'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

const claudeDir = tempDir();
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const installer = require('../src/core/installer');

const settingsFile = path.join(claudeDir, 'settings.json');
const userHook = { type: 'command', command: '/usr/local/bin/my-lint.sh' };

test('install keeps existing settings and hooks', () => {
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ model: 'opus', hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [userHook] }] } }),
  );
  installer.install({ nodePath: '/opt/node/bin/node' });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.PostToolUse[0], { matcher: 'Edit', hooks: [userHook] });
  for (const event of installer.STATUS_EVENTS) {
    const ours = settings.hooks[event]
      .flatMap((g) => g.hooks)
      .filter((h) => (h.args || []).some((a) => a.endsWith('pet-hook.js')) && !h.args.includes('--gate'));
    assert.equal(ours.length, 1, event);
    assert.equal(Boolean(ours[0].async), installer.ASYNC_EVENTS.has(event), event);
    assert.equal(ours[0].command, '/opt/node/bin/node');
  }
  const gates = Object.entries(settings.hooks).flatMap(([event, groups]) =>
    groups.flatMap((g) => g.hooks.filter((h) => (h.args || []).includes('--gate')).map((h) => ({ event, ...h }))),
  );
  assert.equal(gates.length, 1);
  assert.equal(gates[0].event, 'PreToolUse');
  assert.ok(!gates[0].async, 'the pause gate must be synchronous to stop Claude');
  const permission = settings.hooks.PermissionRequest.flatMap((g) => g.hooks).find((h) =>
    (h.args || []).some((a) => a.endsWith('pet-hook.js')),
  );
  assert.ok(permission.timeout > 600, 'the permission hook waits for the pet');
  const expansion = settings.hooks.UserPromptExpansion[0];
  assert.equal(expansion.matcher, 'pet');
  assert.ok(!expansion.hooks[0].async, '/pet must be synchronous to block the expansion');
  assert.ok(fs.existsSync(`${settingsFile}.claude-pet.bak`));
  assert.ok(installer.isInstalled());
});

test('install is idempotent', () => {
  installer.install({ nodePath: '/opt/node/bin/node' });
  installer.install({ nodePath: '/opt/node/bin/node' });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.PostToolUse.length, 2); // the user's hook + ours
});

test('skills are written with absolute paths', () => {
  const pet = fs.readFileSync(path.join(claudeDir, 'skills', 'pet', 'SKILL.md'), 'utf8');
  assert.match(pet, /"\/opt\/node\/bin\/node" ".*claude-pet\.js" pet \$ARGUMENTS/);
  assert.doesNotMatch(pet, /\{\{/);
  const hatch = fs.readFileSync(path.join(claudeDir, 'skills', 'hatch-pet', 'SKILL.md'), 'utf8');
  assert.match(hatch, /build-pet\.js/);
  assert.doesNotMatch(hatch, /\{\{/);
});

test('uninstall removes only our hooks and skills', () => {
  const userSkill = path.join(claudeDir, 'skills', 'mine', 'SKILL.md');
  fs.mkdirSync(path.dirname(userSkill), { recursive: true });
  fs.writeFileSync(userSkill, '# mine');

  installer.uninstall();
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(settings.hooks, { PostToolUse: [{ matcher: 'Edit', hooks: [userHook] }] });
  assert.equal(settings.model, 'opus');
  assert.ok(!fs.existsSync(path.join(claudeDir, 'skills', 'pet')));
  assert.ok(!fs.existsSync(path.join(claudeDir, 'skills', 'hatch-pet')));
  assert.ok(fs.existsSync(userSkill));
  assert.ok(!installer.isInstalled());
});

test('install refuses to overwrite settings that are not valid JSON', () => {
  fs.writeFileSync(settingsFile, '{ broken');
  assert.throws(() => installer.install(), /JSON/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ broken');
});
