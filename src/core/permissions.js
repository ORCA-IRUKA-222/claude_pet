'use strict';

// Answering Claude Code's permission prompts from the pet.
//
// The PermissionRequest hook posts the request to the pet and waits. The pet
// shows 許可 / 拒否 buttons; the answer goes back to the hook, which prints it
// as the hook's decision. If the prompt is answered in the terminal instead,
// times out, or the user picks "answer in the terminal", the hook gets no
// decision and Claude Code carries on as usual.
//
// Answers are signed with a secret that only the pet and the hook can read
// (~/.claude-pet/secret), so another program listening on the pet's port
// can't approve tool calls on its own.

const crypto = require('crypto');
const { EventEmitter } = require('events');

// Events that show the prompt was dealt with somewhere else.
const SESSION_MOVED_ON = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'PetPaused', 'PermissionRequest']);
const TOOL_FINISHED = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);

function sign(secret, nonce, behavior) {
  return crypto.createHmac('sha256', secret).update(`${nonce}:${behavior}`).digest('hex');
}

function verify(secret, nonce, behavior, signature) {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(sign(secret, nonce, behavior), 'hex'), Buffer.from(signature, 'hex'));
}

class PermissionBroker extends EventEmitter {
  constructor({ timeoutMs = 120e3, now = Date.now } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.pending = new Map();
  }

  /**
   * Hold a request until it is answered.
   * @returns {Promise<{behavior: 'allow'|'deny'}|null>} null means "no decision"
   */
  request(event, { signal } = {}) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const entry = {
        id,
        sessionId: String(event.session_id || ''),
        toolName: event.tool_name || null,
        tool: event.tool || null,
        createdAt: this.now(),
        expiresAt: this.now() + this.timeoutMs,
        resolve,
        timer: setTimeout(() => this.settle(id, null), this.timeoutMs),
      };
      this.pending.set(id, entry);
      if (signal) {
        if (signal.aborted) return this.settle(id, null);
        signal.addEventListener('abort', () => this.settle(id, null), { once: true });
      }
      this.emit('change');
    });
  }

  /** The user's answer from the pet: 'allow', 'deny', or null to leave it to the terminal. */
  answer(id, behavior) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.settle(id, behavior === 'allow' || behavior === 'deny' ? { behavior } : null);
    return true;
  }

  settle(id, decision) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    this.emit('change');
  }

  /** Watch hook events: a prompt answered in the terminal shouldn't keep its buttons. */
  observe(event) {
    if (!event || !this.pending.size) return;
    const finishedTool = TOOL_FINISHED.has(event.event);
    if (!SESSION_MOVED_ON.has(event.event) && !finishedTool) return;
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId !== event.session_id) continue;
      if (finishedTool && event.tool_name && entry.toolName && event.tool_name !== entry.toolName) continue;
      this.settle(entry.id, null);
    }
  }

  forSession(sessionId) {
    for (const entry of this.pending.values()) if (entry.sessionId === sessionId) return entry;
    return null;
  }

  list() {
    return [...this.pending.values()].map(({ id, sessionId, toolName, tool, createdAt, expiresAt }) => ({
      id,
      sessionId,
      toolName,
      tool,
      createdAt,
      expiresAt,
    }));
  }

  cancelAll() {
    for (const id of [...this.pending.keys()]) this.settle(id, null);
  }
}

module.exports = { PermissionBroker, sign, verify };
