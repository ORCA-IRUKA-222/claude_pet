'use strict';

// Quick chat: ask Claude Code from the pet. Each message runs `claude -p` with
// stream-json output; follow-ups reuse the session with --resume, and the
// conversation can be continued in a terminal afterwards.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanEnv } = require('../shared/env');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,}$/;
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
const MODEL = /^[\w.:[\]-]+$/;
const SHELL_UNSAFE = /["%!^&|<>\r\n]/; // Windows runs claude.cmd through cmd.exe
const MAX_ATTACHMENTS = 10;

/** Files dropped on the pet (or a screenshot): existing absolute paths only. */
function validAttachments(files, { platform = process.platform } = {}) {
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const file of files) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || out.includes(file)) continue;
    if (platform === 'win32' && SHELL_UNSAFE.test(file)) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() && !stat.isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(file);
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/** The prompt with the attached paths listed, and the folders Claude must be allowed to read. */
function withAttachments(prompt, files, heading = 'Attached files') {
  if (!files.length) return { prompt, addDirs: [] };
  const list = files.map((f) => `- ${f}`).join('\n');
  const addDirs = [
    ...new Set(
      files.map((f) => {
        try {
          return fs.statSync(f).isDirectory() ? f : path.dirname(f);
        } catch {
          return path.dirname(f);
        }
      }),
    ),
  ];
  return { prompt: `${prompt}\n\n${heading}:\n${list}`, addDirs };
}

function buildArgs({ resume, permissionMode, model, addDirs = [] }) {
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
  for (const dir of addDirs) {
    if (!path.isAbsolute(dir) || SHELL_UNSAFE.test(dir)) throw new Error('invalid folder');
    args.push('--add-dir', process.platform === 'win32' ? `"${dir}"` : dir);
  }
  return args;
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

  send({ prompt, cwd, resume, addDirs = [] }) {
    if (this.child) throw new Error('busy');
    if (!prompt || !String(prompt).trim()) throw new Error('empty prompt');
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const args = buildArgs({ resume, permissionMode: this.permissionMode, model: this.model, addDirs });

    // npm installs `claude.cmd` on Windows, which needs a shell. Arguments are validated above.
    const useShell = process.platform === 'win32';
    const command = useShell && /\s/.test(this.claudePath) ? `"${this.claudePath}"` : this.claudePath;
    const child = spawn(command, args, {
      cwd: dir,
      env: cleanEnv(process.env, { CLAUDE_PET_SOURCE: 'quickchat' }),
      shell: useShell,
      windowsHide: true,
    });
    this.child = child;

    let buffer = '';
    let stderr = '';
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
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => {
      this.child = null;
      this.emit('event', { type: 'error', message: err.code === 'ENOENT' ? `${this.claudePath} が見つかりません` : err.message });
    });
    child.on('close', (code) => {
      this.child = null;
      if (!sawResult && code !== 0) {
        this.emit('event', { type: 'error', message: stderr.trim().split('\n').pop() || `exit ${code}` });
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

module.exports = { QuickChat, buildArgs, parseLine, validAttachments, withAttachments, SESSION_ID };
