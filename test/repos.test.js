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

const { listGitHubRepos, isCloned } = require('../src/core/repos');

function fakeTool(name, script) {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("your repositories come from GitHub with git's own sign-in", { skip: process.platform === 'win32' }, async () => {
  const git = fakeTool(
    'git',
    'cat > /dev/null; printf "protocol=https\\nhost=github.com\\nusername=me\\npassword=gho_secret\\n"',
  );
  const calls = [];
  const fetchImpl = async (url, { headers }) => {
    calls.push({ url, auth: headers.authorization });
    return {
      ok: true,
      json: async () => [
        { full_name: 'me/explorer-pinned', description: 'ピン止め', private: true, pushed_at: '2026-10-25T10:00:00Z' },
        { full_name: 'me/claude_pet', description: '', private: false, pushed_at: '2026-10-24T10:00:00Z' },
      ],
    };
  };
  const { repos, source } = await listGitHubRepos({ git, gh: '/nonexistent/gh', fetchImpl });
  assert.equal(source, 'git');
  assert.equal(calls[0].auth, 'Bearer gho_secret');
  assert.match(calls[0].url, /\/user\/repos\?per_page=100&sort=pushed/);
  assert.deepEqual(repos[0], {
    fullName: 'me/explorer-pinned',
    description: 'ピン止め',
    private: true,
    pushedAt: '2026-10-25T10:00:00Z',
  });
});

test(
  'without a git sign-in, the GitHub CLI is used; with neither, it says so',
  { skip: process.platform === 'win32' },
  async () => {
    const noGit = fakeTool('git', 'cat > /dev/null; exit 1');
    const gh = fakeTool(
      'gh',
      `echo '[{"nameWithOwner":"me/old","description":"","isPrivate":false,"pushedAt":"2026-01-01T00:00:00Z"},{"nameWithOwner":"me/new","description":"x","isPrivate":true,"pushedAt":"2026-10-01T00:00:00Z"}]'`,
    );
    const { repos, source } = await listGitHubRepos({ git: noGit, gh });
    assert.equal(source, 'gh');
    assert.deepEqual(
      repos.map((r) => r.fullName),
      ['me/new', 'me/old'],
    );
    await assert.rejects(listGitHubRepos({ git: noGit, gh: '/nonexistent/gh' }), (err) => err.code === 'NO_GITHUB');
  },
);

test('a repository already under ~/claude-repos is marked as here', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'me', 'app', '.git'), { recursive: true });
  assert.equal(isCloned('me/app', root), true);
  assert.equal(isCloned('me/other', root), false);
});
