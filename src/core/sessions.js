'use strict';

// Turns Claude Code hook events into per-session status, mirroring ChatGPT's
// pet states: running, waiting (needs input), ready (finished, unread) and
// failed (blocked by an error). "idle" means nothing needs attention.

const { EventEmitter } = require('events');
const path = require('path');

const PRIORITY = ['waiting', 'failed', 'running', 'ready', 'idle'];

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'ToolSearch']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
// Tools that stop and wait for the user even without a permission prompt.
const ASK_TOOLS = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

function toolActivity(tool) {
  if (READ_TOOLS.has(tool)) return 'reading';
  if (WEB_TOOLS.has(tool)) return 'web';
  if (EDIT_TOOLS.has(tool)) return 'editing';
  if (COMMAND_TOOLS.has(tool)) return 'command';
  if (AGENT_TOOLS.has(tool)) return 'subagent';
  return 'tool';
}

function toolDetail(e) {
  if (!e.tool_name) return null;
  return e.tool ? `${e.tool_name}: ${e.tool}` : e.tool_name;
}

function newSession(id, cwd, ts, extra = {}) {
  return {
    id,
    cwd: cwd || '',
    project: cwd ? path.basename(cwd) : id.slice(0, 8),
    title: null,
    source: 'cli',
    entrypoint: null,
    url: null, // cloud and browser sessions open here instead of in a terminal
    status: 'idle',
    activity: null,
    detail: null,
    prompt: null,
    message: null,
    error: null,
    unread: false,
    waitingTool: null,
    subagents: 0,
    backgroundTasks: 0,
    stale: false,
    history: false,
    startedAt: ts,
    updatedAt: ts,
    lastTs: 0,
    ...extra,
  };
}

/** Status as the pet shows it: a ready session that was already seen counts as idle. */
function effectiveStatus(session) {
  if (session.status === 'ready' && !session.unread) return 'idle';
  return session.status;
}

class SessionTracker extends EventEmitter {
  constructor({ now = Date.now, staleMs = 30 * 60e3, expireMs = 12 * 3600e3 } = {}) {
    super();
    this.now = now;
    this.staleMs = staleMs;
    this.expireMs = expireMs;
    this.sessions = new Map();
  }

  handle(e) {
    if (!e || typeof e.session_id !== 'string' || !e.session_id || typeof e.event !== 'string') return null;
    if (e.event === 'UserPromptExpansion') return null;
    // `/pet` is answered by its own hook and never reaches Claude, so no Stop follows.
    if (e.event === 'UserPromptSubmit' && /^\/pet(\s|$)/.test(e.prompt || '')) return null;

    const id = e.session_id;
    if (e.event === 'SessionEnd') {
      if (this.sessions.delete(id)) this.emit('change');
      return null;
    }

    const ts = Number.isFinite(e.ts) ? e.ts : this.now();
    let s = this.sessions.get(id);
    if (!s) {
      s = newSession(id, e.cwd, ts, { source: e.source || 'cli', entrypoint: e.entrypoint || null });
      this.sessions.set(id, s);
    }

    // Hooks run asynchronously, so a slower process can deliver an older event late.
    if (ts < s.lastTs) return this.snapshot(s);
    s.lastTs = ts;
    s.updatedAt = this.now();
    s.stale = false;
    s.history = false;
    if (e.cwd) {
      s.cwd = e.cwd;
      s.project = path.basename(e.cwd);
    }
    if (e.title) s.title = e.title;
    if (typeof e.url === 'string' && /^https:\/\/claude\.ai\//.test(e.url)) s.url = e.url;
    if (e.permission_mode) s.permissionMode = e.permission_mode;

    const before = { status: s.status, unread: s.unread };
    this.apply(s, e);

    if (before.status !== s.status || before.unread !== s.unread) {
      this.emit('transition', { session: this.snapshot(s), from: before.status, to: s.status });
    }
    this.emit('change');
    return this.snapshot(s);
  }

  apply(s, e) {
    const waiting = s.status === 'waiting';
    switch (e.event) {
      case 'SessionStart':
        break;

      case 'UserPromptSubmit':
        this.setRunning(s, 'thinking', null);
        s.prompt = e.prompt || null;
        s.message = null;
        s.error = null;
        s.unread = false;
        break;

      case 'PreToolUse':
        if (ASK_TOOLS[e.tool_name]) {
          this.setWaiting(s, ASK_TOOLS[e.tool_name], e.tool || null, e.tool_name);
        } else if (!waiting || !s.waitingTool) {
          this.setRunning(s, toolActivity(e.tool_name), toolDetail(e));
        }
        break;

      case 'PermissionRequest':
        this.setWaiting(s, 'permission', toolDetail(e), e.tool_name);
        break;

      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        // A parallel tool finishing doesn't answer the prompt that is still open.
        if (waiting && s.waitingTool && e.tool_name !== s.waitingTool) break;
        this.setRunning(s, 'thinking', null);
        break;

      case 'Notification':
        if (WAITING_NOTIFICATIONS.has(e.notification_type)) {
          if (!waiting) this.setWaiting(s, 'input', e.message || null, null);
        } else if (e.notification_type === 'idle_prompt' && s.status === 'running') {
          // No Stop arrived (the turn was interrupted), and Claude is now idle.
          this.setIdle(s);
        }
        break;

      case 'SubagentStart':
        s.subagents += 1;
        if (s.status === 'running') s.activity = 'subagent';
        break;

      case 'SubagentStop':
        s.subagents = Math.max(0, s.subagents - 1);
        break;

      case 'PreCompact':
        s.beforeCompact = s.status === 'running' ? null : { status: s.status, unread: s.unread };
        this.setRunning(s, 'compacting', null);
        break;

      case 'PostCompact':
        if (s.beforeCompact && s.activity === 'compacting') {
          s.status = s.beforeCompact.status;
          s.unread = s.beforeCompact.unread;
          s.activity = null;
        } else if (s.activity === 'compacting') {
          s.activity = 'thinking';
        }
        s.beforeCompact = null;
        break;

      case 'Stop':
        s.status = 'ready';
        s.unread = true;
        s.activity = null;
        s.detail = null;
        s.waitingTool = null;
        s.subagents = 0;
        s.message = e.message || null;
        s.backgroundTasks = e.background_tasks || 0;
        break;

      case 'StopFailure':
        s.status = 'failed';
        s.unread = true;
        s.activity = null;
        s.waitingTool = null;
        s.error = e.error || 'unknown';
        s.detail = e.error_details || null;
        s.message = e.message || null;
        break;

      default:
        break;
    }
  }

  setRunning(s, activity, detail) {
    s.status = 'running';
    s.activity = activity;
    s.detail = detail;
    s.waitingTool = null;
  }

  setWaiting(s, activity, detail, tool) {
    s.status = 'waiting';
    s.activity = activity;
    s.detail = detail;
    s.waitingTool = tool;
  }

  setIdle(s) {
    s.status = 'idle';
    s.activity = null;
    s.detail = null;
    s.waitingTool = null;
    s.unread = false;
  }

  markRead(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status === 'ready' || s.status === 'failed') {
      const from = s.status;
      this.setIdle(s);
      s.error = null;
      this.emit('transition', { session: this.snapshot(s), from, to: 'idle' });
    }
    s.unread = false;
    this.emit('change');
    return true;
  }

  markAllRead() {
    for (const id of this.sessions.keys()) this.markRead(id);
  }

  dismiss(id) {
    const removed = this.sessions.delete(id);
    if (removed) this.emit('change');
    return removed;
  }

  /** Expire sessions whose hooks went quiet (crashed terminals, interrupted turns). */
  /**
   * Add past conversations (from Claude Code's transcripts) as idle, already-read sessions.
   * Live sessions are never overwritten.
   */
  seed(list) {
    let added = false;
    for (const h of list || []) {
      if (!h || !h.id || this.sessions.has(h.id)) continue;
      const s = newSession(h.id, h.cwd, h.updatedAt, { history: true });
      Object.assign(s, { title: h.title || null, prompt: h.prompt || null, message: h.message || null });
      this.sessions.set(h.id, s);
      added = true;
    }
    if (added) this.emit('change');
    return added;
  }

  prune() {
    const now = this.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      const quiet = now - s.updatedAt;
      if (quiet > this.expireMs && !s.history) {
        this.sessions.delete(id);
        changed = true;
      } else if ((s.status === 'running' || s.status === 'waiting') && quiet > this.staleMs) {
        this.setIdle(s);
        s.stale = true;
        changed = true;
      }
    }
    if (changed) this.emit('change');
    return changed;
  }

  snapshot(s) {
    const { lastTs, beforeCompact, waitingTool, ...rest } = s;
    return { ...rest, effectiveStatus: effectiveStatus(s) };
  }

  list() {
    return [...this.sessions.values()]
      .map((s) => this.snapshot(s))
      .sort((a, b) => PRIORITY.indexOf(a.effectiveStatus) - PRIORITY.indexOf(b.effectiveStatus) || b.updatedAt - a.updatedAt);
  }

  aggregate() {
    const sessions = this.list();
    const counts = { waiting: 0, failed: 0, running: 0, ready: 0, idle: 0 };
    for (const s of sessions) counts[s.effectiveStatus] += 1;
    const primary = sessions[0] || null;
    return {
      status: primary ? primary.effectiveStatus : 'idle',
      activity: primary ? primary.activity : null,
      counts,
      primary,
      total: sessions.length,
    };
  }
}

module.exports = { SessionTracker, effectiveStatus, toolActivity, PRIORITY };
