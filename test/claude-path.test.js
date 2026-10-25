'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');
const { findClaude, isClaudeExecutable } = require('../src/core/claude-path');
const { buildId } = require('../src/shared/build');

const only =
  (...files) =>
  (file) =>
    files.includes(file);

test('findClaude prefers the configured path, then the one the hook reported', () => {
  assert.equal(findClaude({ configured: 'D:\\tools\\claude.exe', exists: () => false }), 'D:\\tools\\claude.exe');
  const learned = '/opt/claude-code/bin/claude';
  assert.equal(findClaude({ learned, platform: 'linux', env: {}, home: '/h', exists: only(learned) }), learned);
});

test('findClaude searches PATH and the usual install folders', () => {
  const env = { PATH: '/usr/bin:/home/me/bin' };
  assert.equal(
    findClaude({ platform: 'linux', env, home: '/home/me', exists: only('/home/me/bin/claude') }),
    '/home/me/bin/claude',
  );
  // started at sign-in on Windows: PATH lacks it, the native installer's folder has it
  const win = { Path: 'C:\\Windows\\system32', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' };
  assert.equal(
    findClaude({ platform: 'win32', env: win, home: 'C:\\Users\\me', exists: only('C:\\Users\\me\\.local\\bin\\claude.exe') }),
    'C:\\Users\\me\\.local\\bin\\claude.exe',
  );
  assert.equal(
    findClaude({
      platform: 'win32',
      env: win,
      home: 'C:\\Users\\me',
      exists: only('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'),
    }),
    'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
  );
  assert.equal(findClaude({ platform: 'win32', env: win, home: 'C:\\Users\\me', exists: () => false }), null);
});

test('only a real claude executable is learned from a hook', () => {
  const dir = tempDir();
  const claude = path.join(dir, 'claude');
  const other = path.join(dir, 'evil');
  fs.writeFileSync(claude, '');
  fs.writeFileSync(other, '');
  assert.equal(isClaudeExecutable(claude), true);
  assert.equal(isClaudeExecutable(other), false);
  assert.equal(isClaudeExecutable(path.join(dir, 'missing', 'claude')), false);
  assert.equal(isClaudeExecutable('claude'), false);
});

test('buildId reads the commit from loose and packed refs', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads', 'feature'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  fs.writeFileSync(path.join(root, '.git', 'packed-refs'), '# pack-refs\n0123456789abcdef0123 refs/heads/feature/x\n');
  assert.equal(buildId(root), '0123456789ab');
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'feature', 'x'), 'fedcba9876543210fedc\n');
  assert.equal(buildId(root), 'fedcba987654');
  assert.equal(buildId(tempDir()), null);
});
