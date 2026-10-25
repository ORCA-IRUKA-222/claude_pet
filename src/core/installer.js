'use strict';

// Adds/removes Claude Pet's hooks in ~/.claude/settings.json and installs the
// /pet and /hatch-pet skills into ~/.claude/skills. Existing settings are kept;
// our entries are recognised by the hook script path.

const fs = require('fs');
const path = require('path');
const { APP_ROOT, PERMISSION_TIMEOUT_MAX, claudeDir } = require('../shared/config');

const HOOK_SCRIPT = path.join(APP_ROOT, 'src', 'hook', 'pet-hook.js');
const CLI_SCRIPT = path.join(APP_ROOT, 'bin', 'claude-pet.js');
const SKILLS = ['pet', 'hatch-pet'];

// Events that fire on every tool call run in the background (async) so they
// never slow Claude down. The rest are rare and run synchronously, which keeps
// them in order and makes sure Claude Code waits for them before exiting.
// (The PreToolUse pause gate below is the one synchronous per-tool hook.)
const ASYNC_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const STATUS_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
  'TaskCreated',
  'TaskCompleted',
];

function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}

function isOurs(handler) {
  if (!handler || handler.type !== 'command') return false;
  const parts = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])].join(' ');
  return parts.includes('pet-hook.js') || (parts.includes('claude-pet.js') && parts.includes('slash-hook'));
}

function buildHooks(nodePath) {
  const hooks = {};
  for (const event of STATUS_EVENTS) {
    const handler = { type: 'command', command: nodePath, args: [HOOK_SCRIPT], timeout: 5 };
    if (ASYNC_EVENTS.has(event)) handler.async = true;
    // Waits for 許可 / 拒否 from the pet; the hook itself gives up after permissionPrompt.timeoutSeconds.
    if (event === 'PermissionRequest') handler.timeout = PERMISSION_TIMEOUT_MAX + 30;
    hooks[event] = [{ hooks: [handler] }];
  }
  // A synchronous gate so 一時停止 in the pet can stop Claude before its next tool call.
  // It only checks for a marker file, so it adds no network round trip to tool calls.
  hooks.PreToolUse[0].hooks.push({ type: 'command', command: nodePath, args: [HOOK_SCRIPT, '--gate'], timeout: 5 });
  // `/pet` is handled by a synchronous hook that blocks the expansion, so it
  // toggles the pet without spending a model turn.
  hooks.UserPromptExpansion = [
    { matcher: 'pet', hooks: [{ type: 'command', command: nodePath, args: [CLI_SCRIPT, 'slash-hook'], timeout: 15 }] },
  ];
  return hooks;
}

/** Remove our handlers from a settings.hooks object (returns a new object). */
function stripHooks(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} を JSON として読めませんでした。手で直してから再実行してください (${err.message})`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.claude-pet.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function renderSkill(name, nodePath) {
  const template = fs.readFileSync(path.join(APP_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  const q = (p) => JSON.stringify(p.split(path.sep).join('/'));
  return template
    .replaceAll('{{NODE}}', q(nodePath))
    .replaceAll('{{CLI}}', q(CLI_SCRIPT))
    .replaceAll('{{BUILD}}', q(path.join(APP_ROOT, 'tools', 'build-pet.js')))
    .replaceAll('{{APP_ROOT}}', APP_ROOT.split(path.sep).join('/'));
}

function install({ nodePath = process.execPath } = {}) {
  const file = settingsPath();
  const settings = readSettings(file);
  const merged = stripHooks(settings.hooks);
  for (const [event, groups] of Object.entries(buildHooks(nodePath))) {
    merged[event] = [...(merged[event] || []), ...groups];
  }
  settings.hooks = merged;
  writeSettings(file, settings);

  const skillsDir = path.join(claudeDir(), 'skills');
  for (const name of SKILLS) {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkill(name, nodePath));
  }
  return { settings: file, skills: SKILLS.map((n) => path.join(skillsDir, n)) };
}

function uninstall() {
  const file = settingsPath();
  const removed = { settings: null, skills: [] };
  if (fs.existsSync(file)) {
    const settings = readSettings(file);
    const stripped = stripHooks(settings.hooks);
    if (Object.keys(stripped).length) settings.hooks = stripped;
    else delete settings.hooks;
    writeSettings(file, settings);
    removed.settings = file;
  }
  for (const name of SKILLS) {
    const skillFile = path.join(claudeDir(), 'skills', name, 'SKILL.md');
    // Only remove skills we generated.
    if (fs.existsSync(skillFile) && fs.readFileSync(skillFile, 'utf8').includes('claude-pet')) {
      fs.rmSync(path.dirname(skillFile), { recursive: true, force: true });
      removed.skills.push(path.dirname(skillFile));
    }
  }
  return removed;
}

function isInstalled() {
  try {
    const hooks = readSettings(settingsPath()).hooks || {};
    return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some((g) => (g.hooks || []).some(isOurs)));
  } catch {
    return false;
  }
}

module.exports = {
  install,
  uninstall,
  isInstalled,
  stripHooks,
  buildHooks,
  settingsPath,
  STATUS_EVENTS,
  ASYNC_EVENTS,
  HOOK_SCRIPT,
  CLI_SCRIPT,
};
