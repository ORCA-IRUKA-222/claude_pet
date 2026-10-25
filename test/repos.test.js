'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');
const { parseRepo, cloneRepo, remember } = require('../src/core/repos');

test('repositories can be named as owner/repo, a URL or an SSH remote', () => {
  const want = { owner: 'ORCA-IRUKA-222', repo: 'claude_pet' };
  assert.deepEqual(parseRepo('ORCA-IRUKA-222/claude_pet'), want);
  assert.deepEqual(parseRepo('https://github.com/ORCA-IRUKA-222/claude_pet'), want);
  assert.deepEqual(parseRepo('https://github.com/ORCA-IRUKA-222/claude_pet.git'), want);
  assert.deepEqual(parseRepo('git@github.com:ORCA-IRUKA-222/claude_pet.git'), want);
  assert.equal(parseRepo('../etc'), null);
  assert.equal(parseRepo('a/..'), null);
  assert.equal(parseRepo('https://gitlab.com/a/b'), null);
  assert.equal(parseRepo('just-a-name'), null);
});

test('a repository already cloned is reused without running git', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'me', 'app', '.git'), { recursive: true });
  const res = await cloneRepo('me/app', { root, git: '/nonexistent/git' });
  assert.deepEqual(res, { dir: path.join(root, 'me', 'app'), existed: true });
  await assert.rejects(cloneRepo('nope', { root }), (err) => err.code === 'BAD_REPO');
  await assert.rejects(cloneRepo('me/other', { root, git: '/nonexistent/git' }), (err) => err.code === 'NO_GIT');
});

test('recent folders: newest first, no duplicates, limited', () => {
  assert.deepEqual(remember(['/a', '/b', '/c'], '/b'), ['/b', '/a', '/c']);
  assert.deepEqual(remember(undefined, '/a'), ['/a']);
  assert.equal(remember(['1', '2', '3', '4', '5', '6', '7', '8'], '9').length, 8);
});
