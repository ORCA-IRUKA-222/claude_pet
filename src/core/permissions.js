'use strict';

// Answering Claude Code's permission prompts from the pet.
//
// The PermissionRequest hook posts the request to the pet and waits. The pet
// shows 許可 / 拒否 buttons; the answer goes back to the hook, which prints it
// as the hook's decision. If the prompt is answered in the terminal instead,
// times out, or the user picks "answer in the terminal", the hook gets no
// decision and Claude Code carries on as usual.
//
// The user can also let a whole session, or every session, through without asking:
// those requests are allowed as soon as they arrive.
//
// Answers are signed with a secret that only the pet and the hook can read
// (~/.claude-pet/secret), so another program listening on the pet's port
// can't approve tool calls on its own.

const crypto = require('crypto');
const { EventEmitter } = require('events');

// Events that show the prompt was dealt with somewhere else.
const SESSION_MOVED_ON = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'PetPaused', 'PermissionRequest']);
const TOOL_FINISHED = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);

/** Answers to AskUserQuestion (question → chosen label) as stable text, so they can be signed. */
function answersPayload(answers) {
  if (!answers || typeof answers !== 'object') return '';
  return JSON.stringify(
    Object.keys(answers)
      .sort()
      .map((k) => [k, String(answers[k])]),
  );
}

function sign(secret, nonce, behavior, payload = '') {
  return crypto
    .createHmac('sha256', secret)
    .update(`${nonce}:${behavior}${payload ? `:${payload}` : ''}`)
    .digest('hex');
}

function verify(secret, nonce, behavior, signature, payload = '') {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(sign(secret, nonce, behavior, payload), 'hex'), Buffer.from(signature, 'hex'));
}

const QUESTION_TOOL = 'AskUserQuestion';
const MAX_ANSWER = 500;

class PermissionBroker extends EventEmitter {
  constructor({ timeoutMs = 120e3, now = Date.now, allowAll = false } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.pending = new Map();
    this.allowAll = Boolean(allowAll); // every session, until turned off
    // 「このセッションは全部許可」, until the pet restarts: a chat in the pet ends its process
    // after every reply, and goes on in the same session
    this.allowedSessions = new Set();
  }

  /**
   * Whether this request is allowed without asking. A question can't be: "allow" alone
   * doesn't answer it, and what to answer is the user's to say.
   */
  autoAllows(event) {
    if (event && event.tool_name === QUESTION_TOOL) return false;
    return this.allowAll || this.allowedSessions.has(String((event && event.session_id) || ''));
  }

  setAllowAll(on) {
    this.allowAll = Boolean(on);
    if (this.allowAll)
      for (const entry of [...this.pending.values()])
        if (entry.toolName !== QUESTION_TOOL) this.settle(entry.id, { behavior: 'allow' });
    this.emit('change');
  }

  /** Allow (or stop allowing) everything a session asks; what it is waiting for now goes through. */
  setSessionAllowed(sessionId, on) {
    const id = String(sessionId || '');
    if (!id) return;
    if (on) this.allowedSessions.add(id);
    else this.allowedSessions.delete(id);
    if (on)
      for (const entry of [...this.pending.values()])
        if (entry.sessionId === id && entry.toolName !== QUESTION_TOOL) this.settle(entry.id, { behavior: 'allow' });
    this.emit('change');
  }

  /**
   * Hold a request until it is answered.
   * @returns {Promise<{behavior: 'allow'|'deny'}|null>} null means "no decision"
   */
  request(event, { signal } = {}) {
    if (this.autoAllows(event)) {
      this.emit('auto', event);
      return Promise.resolve({ behavior: 'allow' });
    }
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const entry = {
        id,
        sessionId: String(event.session_id || ''),
        toolName: event.tool_name || null,
        tool: event.tool || null,
        questions: event.tool_name === QUESTION_TOOL && Array.isArray(event.questions) ? event.questions : null,
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

  /**
   * The user's answer from the pet: 'allow', 'deny', 'allow-session' (this one and the rest
   * of the session), or null to leave it to the terminal. A question is answered with
   * `answers` (question → chosen option or typed text), one for each of its questions.
   */
  answer(id, behavior, answers = null) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (entry.toolName === QUESTION_TOOL && behavior !== 'deny' && behavior !== null) {
      const clean = behavior === 'allow' ? cleanAnswers(entry.questions, answers) : null;
      if (!clean) return false; // not an answer to this question: it stays open
      this.settle(id, { behavior: 'allow', answers: clean });
      return true;
    }
    if (behavior === 'allow-session') this.setSessionAllowed(entry.sessionId, true);
    else this.settle(id, behavior === 'allow' || behavior === 'deny' ? { behavior } : null);
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
    return [...this.pending.values()].map(({ id, sessionId, toolName, tool, questions, createdAt, expiresAt }) => ({
      id,
      sessionId,
      toolName,
      tool,
      questions,
      createdAt,
      expiresAt,
    }));
  }

  cancelAll() {
    for (const id of [...this.pending.keys()]) this.settle(id, null);
  }
}

/**
 * The answers for a question set: one text for each question, taken from what was sent
 * (a list from a multiple-choice question is joined with commas, as Claude Code expects).
 * Null when one is missing.
 */
function cleanAnswers(questions, answers) {
  if (!Array.isArray(questions) || !questions.length || !answers || typeof answers !== 'object') return null;
  const out = {};
  for (const q of questions) {
    if (!q || typeof q.question !== 'string') return null;
    let value = answers[q.question];
    if (Array.isArray(value)) value = value.map(String).join(', ');
    if (typeof value !== 'string' || !value.trim()) return null;
    out[q.question] = value.trim().slice(0, MAX_ANSWER);
  }
  return out;
}

module.exports = { PermissionBroker, sign, verify, answersPayload, cleanAnswers, QUESTION_TOOL };
