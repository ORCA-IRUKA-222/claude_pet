'use strict';

// Quick chat: ask Claude Code from the pet. Each message runs `claude -p` with
// stream-json output; follow-ups reuse the session with --resume, and the
// conversation can be continued in a terminal afterwards.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const { cleanEnv } = require('../shared/env');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,}$/;
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
const MODEL = /^[\w.:[\]-]+$/;

function buildArgs({ resume, permissionMode, model }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (resume) {
    if (!SESSION_ID.test(resume)) throw new Error('invalid session id');
    args.push('--resume', resume);
  }
  if (permissionMode && permissionMode !== 'default') {
    if (!PERMISSION_MODES.has(permissionMode)) throw new Error('invalid permission mode');
    args.push('--permission-mode', permissionMode);
  }
  if (model) {
    if (!MODEL.test(model)) throw new Error('invalid model');
    args.push('--model', model);
  }
  return args;
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
  constructor({ claudePath = null, permissionMode = 'default', model = null } = {}) {
    super();
    this.claudePath = claudePath || 'claude';
    this.permissionMode = permissionMode;
    this.model = model;
    this.child = null;
  }

  get busy() {
    return Boolean(this.child);
  }

  send({ prompt, cwd, resume }) {
    if (this.child) throw new Error('busy');
    if (!prompt || !String(prompt).trim()) throw new Error('empty prompt');
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const args = buildArgs({ resume, permissionMode: this.permissionMode, model: this.model });
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
    let stderr = Buffer.alloc(0);
    let sawResult = false;
    let sessionId = resume || null;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        for (const ev of parseLine(line)) {
          if (ev.type === 'session') {
            if (ev.sessionId !== sessionId) {
              sessionId = ev.sessionId;
              this.emit('event', { ...ev, cwd: dir });
            }
            continue;
          }
          if (ev.type === 'result') sawResult = true;
          this.emit('event', ev);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-4000);
    });
    child.on('error', (err) => {
      this.child = null;
      this.emit('event', { type: 'error', message: err.code === 'ENOENT' ? `${claude} が見つかりません` : err.message });
    });
    child.on('close', (code) => {
      this.child = null;
      if (!sawResult && code !== 0) {
        const lines = decodeOutput(stderr).trim().split(/\r?\n/).filter(Boolean);
        this.emit('event', { type: 'error', message: lines.slice(-2).join(' ') || `exit ${code}` });
      }
      this.emit('event', { type: 'done', sessionId, cwd: dir });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(String(prompt));
    return { cwd: dir };
  }

  stop() {
    if (this.child) this.child.kill();
  }
}

module.exports = { QuickChat, buildArgs, parseLine, decodeOutput, SESSION_ID };
