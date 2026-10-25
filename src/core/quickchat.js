'use strict';

// Quick chat: ask Claude Code from the pet. Each message runs `claude -p` with
// stream-json output; follow-ups reuse the session with --resume, and the
// conversation can be continued in a terminal afterwards. With `cloud`, the task
// goes to a new cloud session instead (`claude -p --cloud`, on the GitHub repository
// of the chosen folder), which also shows up in the Claude app.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const { cleanEnv } = require('../shared/env');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,}$/;
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
const MODEL = /^[\w.:[\]-]+$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** --model / --effort, checked: they end up on a command line. */
function modelArgs({ model, effort }) {
  const args = [];
  if (model) {
    if (!MODEL.test(model)) throw new Error('invalid model');
    args.push('--model', model);
  }
  if (effort) {
    if (!EFFORTS.has(effort)) throw new Error('invalid effort');
    args.push('--effort', effort);
  }
  return args;
}
const CLOUD_ID = /^(cse|session)_[A-Za-z0-9]+$/;
const CLOUD_NOTE = /Cloud session: (\S+) \((https:\/\/claude\.ai\/code\/[^\s)]+)\)/;

/** Arguments for a cloud task: a new session, or a follow-up to one (plain text only). */
function buildCloudArgs({ resume, text, model, effort }) {
  if (resume) {
    if (!CLOUD_ID.test(resume)) throw new Error('invalid cloud session id');
    return ['-p', '--cloud', resume];
  }
  const base = text ? ['-p', '--cloud'] : ['-p', '--cloud', '--output-format', 'stream-json', '--verbose'];
  return [...base, ...modelArgs({ model, effort })];
}

function buildArgs({ resume, permissionMode, model, effort }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (resume) {
    if (!SESSION_ID.test(resume)) throw new Error('invalid session id');
    args.push('--resume', resume);
  }
  if (permissionMode && permissionMode !== 'default') {
    if (!PERMISSION_MODES.has(permissionMode)) throw new Error('invalid permission mode');
    args.push('--permission-mode', permissionMode);
  }
  return [...args, ...modelArgs({ model, effort })];
}

/** Error output as text; cmd.exe on Japanese Windows writes Shift_JIS, not UTF-8. */
function decodeOutput(buffer, platform = process.platform) {
  const text = buffer.toString('utf8');
  if (platform !== 'win32' || !text.includes('\uFFFD')) return text;
  try {
    return new TextDecoder('shift_jis').decode(buffer);
  } catch {
    return text;
  }
}

/** Turn one stream-json line into zero or more UI events. */
function parseLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  const out = [];
  if (msg.session_id) out.push({ type: 'session', sessionId: msg.session_id });
  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) out.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use') out.push({ type: 'tool', name: block.name });
    }
  } else if (msg.type === 'result') {
    out.push({ type: 'result', text: typeof msg.result === 'string' ? msg.result : '', isError: Boolean(msg.is_error) });
  }
  return out;
}

class QuickChat extends EventEmitter {
  /** @param {object} opts  `claudePath` may be a function, asked again before every message. */
  constructor({ claudePath = null, permissionMode = 'default', model = null, effort = null } = {}) {
    super();
    this.claudePath = claudePath || 'claude';
    this.permissionMode = permissionMode;
    this.model = model;
    this.effort = effort;
    this.noEffort = false; // set when this Claude Code turns out not to know --effort
    this.child = null;
  }

  get busy() {
    return Boolean(this.child);
  }

  send({ prompt, cwd, resume, cloud = false, text = false }) {
    if (this.child) throw new Error('busy');
    if (!prompt || !String(prompt).trim()) throw new Error('empty prompt');
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const effort = this.noEffort ? null : this.effort;
    const args = cloud
      ? buildCloudArgs({ resume, text, model: this.model, effort })
      : buildArgs({ resume, permissionMode: this.permissionMode, model: this.model, effort });
    const plain = cloud && (text || Boolean(resume)); // output is the reply as plain text
    const claude = typeof this.claudePath === 'function' ? this.claudePath() : this.claudePath;
    if (!claude) throw Object.assign(new Error('claude not found'), { code: 'CLAUDE_NOT_FOUND' });

    // npm installs `claude.cmd` on Windows, which needs a shell. Arguments are validated above.
    const useShell = process.platform === 'win32' && !/\.exe$/i.test(claude);
    const command = useShell && /\s/.test(claude) ? `"${claude}"` : claude;
    const child = spawn(command, args, {
      cwd: dir,
      env: cleanEnv(process.env, { CLAUDE_PET_SOURCE: 'quickchat' }),
      shell: useShell,
      windowsHide: true,
    });
    this.child = child;

    let buffer = '';
    let errBuffer = '';
    let stderr = Buffer.alloc(0);
    let sawResult = false;
    let sawOutput = false;
    let sessionId = cloud ? null : resume || null;

    const stdoutLine = (raw) => {
      const line = raw.trim();
      if (plain || (cloud && !line.startsWith('{'))) {
        if (raw.trim() || sawOutput) this.emit('event', { type: 'raw', text: raw.replace(/\r$/, '') });
        sawOutput = true;
        return;
      }
      if (!line) return;
      sawOutput = true;
      for (const ev of parseLine(line)) {
        if (ev.type === 'session') {
          // a cloud run reports the cloud session's id, which the next message attaches to
          if (cloud) {
            if (CLOUD_ID.test(ev.sessionId)) this.emit('event', { type: 'cloud', cloudSessionId: ev.sessionId });
            continue;
          }
          if (ev.sessionId !== sessionId) {
            sessionId = ev.sessionId;
            this.emit('event', { ...ev, cwd: dir });
          }
          continue;
        }
        if (ev.type === 'result') sawResult = true;
        this.emit('event', ev);
      }
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        stdoutLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stdout.on('end', () => {
      if (buffer) stdoutLine(buffer);
    });
    child.stderr.on('data', (chunk) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-4000);
      if (!cloud) return;
      // progress notes of a cloud run, including the session it created
      errBuffer += chunk.toString('utf8');
      let nl;
      while ((nl = errBuffer.indexOf('\n')) >= 0) {
        const line = errBuffer.slice(0, nl).trim();
        errBuffer = errBuffer.slice(nl + 1);
        const m = CLOUD_NOTE.exec(line);
        if (m) this.emit('event', { type: 'cloud', cloudSessionId: m[1], url: m[2] });
        else if (line) this.emit('event', { type: 'note', text: line });
      }
    });
    child.on('error', (err) => {
      this.child = null;
      this.emit('event', { type: 'error', message: err.code === 'ENOENT' ? `${claude} が見つかりません` : err.message });
    });
    child.on('close', (code) => {
      this.child = null;
      const errors = decodeOutput(stderr);
      // an older Claude Code without --effort: ask again without it
      if (effort && !sawOutput && code !== 0 && /unknown option.{0,4}--effort/i.test(errors)) {
        this.noEffort = true;
        this.send({ prompt, cwd, resume, cloud, text });
        return;
      }
      // older or newer CLIs may not stream a new cloud run as JSON: run it again as plain text
      if (cloud && !plain && !sawOutput && code !== 0 && /stream-json/.test(errors)) {
        this.send({ prompt, cwd, cloud: true, text: true });
        return;
      }
      // Claude Code starts new cloud sessions only interactively (headless start is switched off in
      // released builds): the caller opens a terminal for it
      if (cloud && !resume && code !== 0 && /interactive only|cannot be combined with --print/i.test(errors)) {
        this.emit('event', { type: 'interactive-only', prompt: String(prompt), cwd: dir });
        this.emit('event', { type: 'done', sessionId: null, cwd: dir, cloud });
        return;
      }
      if (!sawResult && code !== 0) {
        const lines = decodeOutput(stderr).trim().split(/\r?\n/).filter(Boolean);
        this.emit('event', { type: 'error', message: lines.slice(-2).join(' ') || `exit ${code}` });
      }
      this.emit('event', { type: 'done', sessionId, cwd: dir, cloud });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(String(prompt));
    return { cwd: dir };
  }

  stop() {
    if (this.child) this.child.kill();
  }
}

module.exports = { QuickChat, buildArgs, buildCloudArgs, modelArgs, parseLine, decodeOutput, SESSION_ID, CLOUD_ID, EFFORTS };
