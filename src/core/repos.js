'use strict';

// GitHub repositories for the quick chat to work in. A cloud task runs on the repository
// of the folder it is sent from, so a repository picked by name is cloned once into
// ~/claude-repos/<owner>/<repo> (a partial clone: history without file contents).

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanEnv } = require('../shared/env');

const NAME = /^[A-Za-z0-9_.-]+$/;

/** "owner/repo", a github.com URL or an SSH remote → { owner, repo }, or null. */
function parseRepo(text) {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(text || '').trim());
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2]) || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return null;
  return { owner: m[1], repo: m[2] };
}

function reposRoot() {
  return path.join(os.homedir(), 'claude-repos');
}

/** Clone (or reuse) the repository and resolve to its folder. */
function cloneRepo(text, { root = reposRoot(), git = 'git' } = {}) {
  const parsed = parseRepo(text);
  if (!parsed) return Promise.reject(Object.assign(new Error('not a GitHub repository'), { code: 'BAD_REPO' }));
  const dest = path.join(root, parsed.owner, parsed.repo);
  if (fs.existsSync(path.join(dest, '.git'))) return Promise.resolve({ dir: dest, existed: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    // no terminal to answer a password prompt; Git Credential Manager still shows its window
    const child = spawn(git, ['clone', '--filter=blob:none', url, dest], {
      env: cleanEnv(process.env, { GIT_TERMINAL_PROMPT: '0' }),
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (err) =>
      reject(err.code === 'ENOENT' ? Object.assign(new Error('git not found'), { code: 'NO_GIT' }) : err),
    );
    child.on('close', (code) => {
      if (code === 0) return resolve({ dir: dest, existed: false });
      fs.rmSync(dest, { recursive: true, force: true });
      const last = stderr.trim().split(/\r?\n/).pop() || `git exited ${code}`;
      reject(new Error(last));
    });
  });
}

/** Most recent first, without duplicates, at most `max`. */
function remember(list, dir, max = 8) {
  return [dir, ...(Array.isArray(list) ? list : []).filter((d) => d && d !== dir)].slice(0, max);
}

/**
 * The GitHub token git already uses on this computer (Git Credential Manager and friends),
 * or null. Asked only when the user opens the repository list; never stored by the pet.
 */
function gitHubToken({ git = 'git' } = {}) {
  const res = spawnSync(git, ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 120000, // a first-time sign-in window may take a while
    windowsHide: true,
    env: cleanEnv(process.env, { GIT_TERMINAL_PROMPT: '0' }),
  });
  if (res.error || res.status !== 0) return null;
  const m = /^password=(.+)$/m.exec(res.stdout || '');
  return m ? m[1].trim() : null;
}

const toRepo = (r) => ({
  fullName: r.full_name || r.nameWithOwner,
  description: r.description || '',
  private: Boolean(r.private ?? r.isPrivate),
  pushedAt: r.pushed_at || r.pushedAt || null,
});

/**
 * Your GitHub repositories, most recently pushed first: through the GitHub API with git's
 * own token, or the GitHub CLI when that's what is signed in.
 */
async function listGitHubRepos({ git = 'git', gh = 'gh', fetchImpl = globalThis.fetch, max = 300 } = {}) {
  const token = gitHubToken({ git });
  if (token) {
    const repos = [];
    for (let page = 1; repos.length < max; page++) {
      const res = await fetchImpl(
        `https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`,
        { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'claude-pet' } },
      );
      if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
      const batch = await res.json();
      repos.push(...batch.map(toRepo));
      if (batch.length < 100) break;
    }
    return { repos: repos.slice(0, max), source: 'git' };
  }
  const cli = spawnSync(gh, ['repo', 'list', '--limit', String(max), '--json', 'nameWithOwner,description,isPrivate,pushedAt'], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (!cli.error && cli.status === 0) {
    const repos = JSON.parse(cli.stdout || '[]').map(toRepo);
    repos.sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
    return { repos, source: 'gh' };
  }
  throw Object.assign(new Error('no GitHub sign-in found'), { code: 'NO_GITHUB' });
}

/** Whether the repository is already cloned under ~/claude-repos. */
function isCloned(fullName, root = reposRoot()) {
  const parsed = parseRepo(fullName);
  return Boolean(parsed) && fs.existsSync(path.join(root, parsed.owner, parsed.repo, '.git'));
}

module.exports = { parseRepo, cloneRepo, remember, reposRoot, listGitHubRepos, gitHubToken, isCloned };
