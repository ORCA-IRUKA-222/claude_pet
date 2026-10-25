#!/usr/bin/env node
'use strict';

// Claude Code hook handler: forwards a compact copy of each hook event to the
// pet app on localhost. It never prints and always exits 0, so a pet that is
// not running can't slow down or break a Claude Code session.

const http = require('http');
const path = require('path');
const { getPort } = require('../shared/config');

const MAX_TEXT = 4000;

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
    case 'NotebookEdit':
      return input.file_path ? path.basename(String(input.file_path)) : undefined;
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
    case 'PermissionDenied':
      Object.assign(event, { tool_name: input.tool_name, tool: summarizeTool(input.tool_name, input.tool_input) });
      if (input.error) event.error = clip(String(input.error), 300);
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

function send(event) {
  const body = Buffer.from(JSON.stringify(event));
  const req = http.request(
    {
      host: '127.0.0.1',
      port: getPort(),
      path: '/event',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout: 1000,
    },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => process.exit(0));
  req.end(body);
}

function main() {
  setTimeout(() => process.exit(0), 3000).unref();
  if (process.stdin.isTTY) process.exit(0);
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || !input.hook_event_name || !input.session_id) process.exit(0);
      send(compact(input));
    } catch {
      process.exit(0);
    }
  });
}

if (require.main === module) main();

module.exports = { compact, summarizeTool };
