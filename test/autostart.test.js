'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');
const autostart = require('../src/core/autostart');

const target = { electron: '/opt/My Apps/electron', appRoot: '/home/me/claude_pet' };

test('Windows: a Run value launches Electron directly', () => {
  const values = new Map();
  const reg = (args) => {
    const [op, key, , name] = args;
    assert.equal(key, autostart.RUN_KEY);
    if (op === 'add') values.set(name, args[args.indexOf('/d') + 1]);
    else if (op === 'delete') values.delete(name);
    else if (!values.has(name)) throw new Error('not found');
    return values.has(name) ? `    ${name}    REG_SZ    ${values.get(name)}` : '';
  };
  const opts = { platform: 'win32', reg, electron: 'C:\\pet\\electron.exe', appRoot: 'C:\\Users\\me\\claude_pet' };
  assert.equal(autostart.isEnabled(opts), false);
  autostart.enable(opts);
  assert.equal(values.get(autostart.NAME), '"C:\\pet\\electron.exe" "C:\\Users\\me\\claude_pet"');
  assert.equal(autostart.isEnabled(opts), true);
  autostart.disable(opts);
  assert.equal(autostart.isEnabled(opts), false);
  autostart.disable(opts); // already off: no error
});

test('macOS: a LaunchAgent that runs at load and keeps PATH', () => {
  const home = tempDir();
  const opts = { platform: 'darwin', home, env: { PATH: '/opt/homebrew/bin:/usr/bin' }, ...target };
  const file = autostart.enable(opts);
  assert.equal(file, path.join(home, 'Library', 'LaunchAgents', 'dev.claude-pet.plist'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /<string>\/opt\/My Apps\/electron<\/string><string>\/home\/me\/claude_pet<\/string>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.equal(autostart.isEnabled(opts), true);
  autostart.disable(opts);
  assert.equal(autostart.isEnabled(opts), false);
});

test('Linux: an XDG autostart entry with quoted paths', () => {
  const home = tempDir();
  const opts = { platform: 'linux', home, env: {}, ...target };
  const file = autostart.enable(opts);
  assert.equal(file, path.join(home, '.config', 'autostart', 'claude-pet.desktop'));
  assert.match(fs.readFileSync(file, 'utf8'), /^Exec="\/opt\/My Apps\/electron" "\/home\/me\/claude_pet"$/m);
  assert.equal(autostart.isEnabled(opts), true);
  autostart.disable(opts);
  assert.equal(autostart.isEnabled(opts), false);
});

test('enable needs to know what to launch', () => {
  assert.throws(() => autostart.enable({ platform: 'linux', home: tempDir(), env: {} }), /required/);
});
