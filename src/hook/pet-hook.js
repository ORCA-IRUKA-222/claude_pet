#!/usr/bin/env node
'use strict';

// Claude Code hook handler: forwards a compact copy of each hook event to the
// pet app on localhost. It always exits 0, so a pet that is not running can't
// slow down or break a Claude Code session. It prints nothing except in two cases:
//   PermissionRequest  waits for 許可 / 拒否 from the pet and prints that decision
//   --gate             (PreToolUse) stops the turn when the pet asked to pause it

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { getPort } = require('../shared/config');

const MAX_TEXT = 4000;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_TODOS = 50;

function clip(value, max = 300) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function summarizeTool(name, input) {
  if (!input || typeof input !== 'object') return undefined;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return clip(input.description || input.command, 120);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = input.file_path || input.notebook_path;
      return file ? path.basename(String(file)) : undefined;
    }
    case 'TaskCreate':
    case 'TaskUpdate':
      return clip(input.subject || input.activeForm, 120);
    case 'Glob':
    case 'Grep':
      return clip(input.pattern, 120);
    case 'WebFetch':
      return clip(input.url, 120);
    case 'WebSearch':
      return clip(input.query, 120);
    case 'Agent':
    case 'Task':
      return clip(input.description || input.subagent_type, 120);
    case 'Skill':
      return clip(input.skill || input.command, 120);
    case 'AskUserQuestion': {
      const first = Array.isArray(input.questions) ? input.questions[0] : null;
      return clip((first && (first.question || first.header)) || input.question, 160);
    }
    default:
      return clip(input.description, 120);
  }
}

/** TodoWrite sends the whole list each time. */
function compactTodos(input) {
  if (!input || !Array.isArray(input.todos)) return undefined;
  return input.todos.slice(0, MAX_TODOS).map((todo) => ({
    text: clip(String((todo && (todo.content || todo.subject)) || ''), 120) || '',
    active: clip(todo && todo.activeForm, 120),
    status: String((todo && todo.status) || 'pending'),
  }));
}

/** The task a TaskCreate / TaskUpdate call is about. The new id is only known after TaskCreate ran. */
function compactTask(name, input, response) {
  if (!input || typeof input !== 'object') return undefined;
  if (name === 'TaskUpdate') {
    const id = input.taskId ?? input.task_id ?? input.id;
    if (id == null) return undefined;
    return { id: String(id), status: input.status, subject: clip(input.subject, 120), active: clip(input.activeForm, 120) };
  }
  if (name === 'TaskCreate') {
    let id =
      response && typeof response === 'object'
        ? ((response.task && response.task.id) ?? response.taskId ?? response.id)
        : undefined;
    if (id == null) {
      const text = typeof response === 'string' ? response : JSON.stringify(response || '');
      const m = text.match(/#(\d+)/);
      id = m ? m[1] : undefined;
    }
    if (id == null) return undefined;
    return { id: String(id), status: 'pending', subject: clip(input.subject, 120), active: clip(input.activeForm, 120) };
  }
  return undefined;
}

function compact(input) {
  const event = {
    event: input.hook_event_name,
    session_id: input.session_id,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    ts: Date.now(),
    source: process.env.CLAUDE_PET_SOURCE || 'cli',
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    term: process.env.TERM_PROGRAM,
  };

  switch (input.hook_event_name) {
    case 'SessionStart':
      Object.assign(event, { start_source: input.source, title: clip(input.session_title, 120) });
      // where Claude Code runs from, so quick chat can find it even when it isn't on PATH
      event.claude_path = process.env.CLAUDE_CODE_EXECPATH;
      break;
    case 'UserPromptSubmit':
      Object.assign(event, { prompt: clip(input.prompt, 300), title: clip(input.session_title, 120) });
      event.claude_path = process.env.CLAUDE_CODE_EXECPATH;
      break;
    case 'UserPromptExpansion':
      event.command_name = input.command_name;
      break;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
    case 'PermissionDenied': {
      Object.assign(event, { tool_name: input.tool_name, tool: summarizeTool(input.tool_name, input.tool_input) });
      if (input.error) event.error = clip(String(input.error), 300);
      const toolInput = input.tool_input || {};
      if (input.hook_event_name === 'PostToolUse' && EDIT_TOOLS.has(input.tool_name)) {
        const file = toolInput.file_path || toolInput.notebook_path;
        if (typeof file === 'string' && path.isAbsolute(file)) event.file_path = file;
      }
      if (input.tool_name === 'TodoWrite') event.todos = compactTodos(toolInput);
      if (input.hook_event_name === 'PostToolUse') event.task = compactTask(input.tool_name, toolInput, input.tool_response);
      break;
    }
    case 'TaskCreated':
    case 'TaskCompleted':
      if (input.task_id != null) {
        event.task = {
          id: String(input.task_id),
          subject: clip(input.task_subject, 120),
          status: input.hook_event_name === 'TaskCompleted' ? 'completed' : 'pending',
        };
      }
      break;
    case 'Notification':
      Object.assign(event, {
        notification_type: input.notification_type,
        message: clip(input.message, 300),
        title: clip(input.title, 120),
      });
      break;
    case 'SubagentStart':
    case 'SubagentStop':
      break;
    case 'Stop':
      Object.assign(event, {
        message: clip(input.last_assistant_message, MAX_TEXT),
        background_tasks: Array.isArray(input.background_tasks) ? input.background_tasks.length : 0,
      });
      break;
    case 'StopFailure':
      Object.assign(event, {
        error: input.error,
        error_details: clip(input.error_details, 300),
        message: clip(input.last_assistant_message, 600),
      });
      break;
    case 'SessionEnd':
      event.reason = input.reason;
      break;
    case 'PreCompact':
    case 'PostCompact':
      event.trigger = input.trigger;
      break;
    default:
      break;
  }
  return event;
}

function exit() {
  process.exit(0);
}

/** POST to the pet and hand the parsed JSON reply (or null) to `done`. */
function post(urlPath, payload, { timeout = 1000 } = {}, done = exit) {
  const body = Buffer.from(JSON.stringify(payload));
  const req = http.request(
    {
      host: '127.0.0.1',
      port: getPort(),
      path: urlPath,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout,
    },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = null;
        }
        done(json);
      });
    },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => done(null));
  req.end(body);
}

function send(event, done = exit) {
  post('/event', event, {}, () => done());
}

function print(output) {
  process.stdout.write(JSON.stringify(output) + '\n', exit);
}

/** PermissionRequest: wait for the user's answer in the pet. No answer → Claude Code asks as usual. */
function askPet(event) {
  const { loadConfig, readSecret, permissionTimeoutMs } = require('../shared/config');
  const config = loadConfig();
  const secret = readSecret();
  if (!secret || !config.permissionPrompt || config.permissionPrompt.enabled === false) return send(event);

  const timeoutMs = permissionTimeoutMs(config);
  setTimeout(exit, timeoutMs + 10e3).unref();
  const nonce = crypto.randomBytes(16).toString('hex');
  post('/permission', { event, nonce }, { timeout: timeoutMs + 5e3 }, (reply) => {
    const { verify } = require('../core/permissions');
    const behavior = reply && reply.behavior;
    if ((behavior !== 'allow' && behavior !== 'deny') || !verify(secret, nonce, behavior, reply.signature)) return exit();
    const t = require('../shared/i18n').translator(config.language);
    const decision = behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: t('permission.deniedByPet') };
    print({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
  });
}

/** PreToolUse gate: stop Claude here if the user pressed 一時停止 in the pet. */
function gate(input) {
  const { takePause } = require('../shared/pause');
  if (input.hook_event_name !== 'PreToolUse' || !takePause(input.session_id)) return exit();
  const { loadConfig } = require('../shared/config');
  const t = require('../shared/i18n').translator(loadConfig().language);
  process.stdout.write(JSON.stringify({ continue: false, stopReason: t('pause.stopReason') }) + '\n', () => {
    send({
      event: 'PetPaused',
      session_id: input.session_id,
      cwd: input.cwd,
      ts: Date.now(),
      source: process.env.CLAUDE_PET_SOURCE || 'cli',
    });
  });
}

function main() {
  const killer = setTimeout(exit, 3000);
  killer.unref();
  if (process.stdin.isTTY) exit();
  const gateMode = process.argv.includes('--gate');
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('error', exit);
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || !input.hook_event_name || !input.session_id) exit();
      if (gateMode) return gate(input);
      const event = compact(input);
      if (input.hook_event_name === 'PermissionRequest') {
        clearTimeout(killer);
        return askPet(event);
      }
      send(event);
    } catch {
      exit();
    }
  });
}

if (require.main === module) main();

module.exports = { compact, summarizeTool, compactTodos, compactTask };
