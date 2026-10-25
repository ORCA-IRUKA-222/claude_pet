'use strict';

/* global PetI18n, PetSprite, PetMarkdown, PetTime, PetTools */

const api = window.pet;
const $ = (id) => document.getElementById(id);

const ui = {
  root: $('root'),
  panel: $('panel'),
  bubble: $('bubble'),
  bubbleTitle: $('bubble-title'),
  bubbleClock: $('bubble-clock'),
  bubblePause: $('bubble-pause'),
  bubbleSub: $('bubble-sub'),
  bubbleActions: $('bubble-actions'),
  bubbleProgress: $('bubble-progress'),
  bubbleProgressFill: $('bubble-progress-fill'),
  stage: $('stage'),
  badge: $('badge'),
  mood: $('mood'),
  mini: $('mini'),
  miniMood: $('mini-mood'),
  miniLabel: $('mini-label'),
  miniBadge: $('mini-badge'),
  sessionsCount: $('sessions-count'),
  timerDot: $('timer-dot'),
  sessionList: $('session-list'),
  sessionsEmpty: $('sessions-empty'),
  setupHint: $('setup-hint'),
  tabSessions: $('tab-sessions'),
  tabChat: $('tab-chat'),
  tabTools: $('tab-tools'),
  chatLog: $('chat-log'),
  chatStop: $('chat-stop'),
  composer: $('composer'),
  composerInput: $('composer-input'),
  composerCwd: $('composer-cwd'),
  composerTarget: $('composer-target'),
  composerSend: $('composer-send'),
};

const sprite = new PetSprite($('sprite'));

const TOOL_TABS = new Set(['timer', 'memo', 'calendar']);
const ATTENTION = ['waiting', 'failed', 'ready'];

const state = {
  config: {
    scale: 0.5,
    mini: false,
    showBubble: true,
    language: 'ja',
    quickChatCwd: '',
    home: '',
    greetings: true,
    permissionPrompt: true,
  },
  pet: null,
  sessions: [],
  aggregate: { status: 'idle', activity: null, counts: {}, primary: null, total: 0 },
  permissions: [], // permission prompts waiting for 許可 / 拒否 in the pet
  modes: { dnd: null, focus: false, away: false },
  mood: { night: false, tired: false },
  hooksInstalled: true,
  panelOpen: false,
  tab: 'sessions',
  expanded: null,
  composerOpen: false,
  // target: local (Claude Code here), cloud (a cloud session: cloudId, url) or chat (a new chat in the app)
  chat: { messages: [], sessionId: null, cwd: '', busy: false, target: 'local', cloudId: null, url: null },
  cloning: false, // the composer asks for a GitHub repository instead of a message
  repos: { loading: false, list: [], index: 0 }, // your GitHub repositories, to pick one while cloning
  attachments: [], // files going with the next message (paths on this computer)
  screenshots: new Set(), // which of them are screenshots, so the default question fits
  temporary: null, // a one-off animation (wave, jump) that overrides the status animation
  toast: null, // { title, sub, sticky } shown in the bubble, e.g. when the pet changes; sticky ones (alarms) stay until clicked
};

let t = PetI18n.translator('ja');
const SOURCE_MARK = { quickchat: '💬 ', cloud: '☁ ', browser: '🌐 ' };
const AUTH_ERROR = /authenticat|oauth|\/login|api key/i;

// ------------------------------------------------------------------ helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, onClick, className = 'text-button') {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b, e);
  });
  return b;
}

function dirname(p) {
  const parts = String(p || '')
    .split(/[\\/]/)
    .filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

function locale() {
  return state.config.language === 'en' ? 'en-US' : 'ja-JP';
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function firstLine(text, max = 140) {
  if (!text) return '';
  const line =
    String(text)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^```/.test(l)) || '';
  const clean = line.replace(/^#+\s*/, '').replace(/\*\*/g, '');
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function timeAgo(ms) {
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return t('ui.justNow');
  if (minutes < 60) return t('ui.minutesAgo', { n: minutes });
  if (minutes < 24 * 60) return t('ui.hoursAgo', { n: Math.floor(minutes / 60) });
  return t('ui.daysAgo', { n: Math.floor(minutes / (24 * 60)) });
}

function sessionName(s) {
  // without a title, the first question says what the conversation is about
  const asked = s.firstPrompt || s.prompt;
  return s.title || (asked && asked.replace(/\s+/g, ' ').slice(0, 60)) || s.project || s.id.slice(0, 8);
}

function activityText(s) {
  if (s.effectiveStatus === 'failed')
    return t(`error.${s.error}`) === `error.${s.error}` ? t('error.unknown') : t(`error.${s.error}`);
  if (s.effectiveStatus === 'ready') return t('bubble.ready');
  if (s.paused && s.effectiveStatus === 'idle') return t('ui.paused');
  if (s.activity) return t(`activity.${s.activity}`);
  return t(`status.${s.effectiveStatus}`);
}

function detailText(s) {
  if (s.pauseRequested && s.effectiveStatus === 'running') return t('ui.pauseRequested');
  switch (s.effectiveStatus) {
    case 'ready':
      return firstLine(s.message) || (s.backgroundTasks ? t('ui.backgroundTasks', { n: s.backgroundTasks }) : '');
    case 'failed':
      return s.detail || firstLine(s.message);
    case 'idle':
      return s.stale ? t('ui.stale') : firstLine(s.message) || firstLine(s.prompt);
    default:
      if (s.todoProgress && s.todoProgress.current && !s.detail) return s.todoProgress.current;
      return s.detail || firstLine(s.prompt);
  }
}

function attentionCount() {
  const c = state.aggregate.counts || {};
  return (c.waiting || 0) + (c.failed || 0) + (c.ready || 0);
}

/** Same rule as the main process: what おやすみモード / a pomodoro focus keeps out of the bubble. */
function held(status) {
  const m = state.modes || {};
  if (!ATTENTION.includes(status)) return false;
  if (status === 'waiting') return Boolean(m.dnd) && !m.dnd.allowWaiting;
  return Boolean(m.dnd) || Boolean(m.focus);
}

function pendingPermission(sessionId) {
  if (!state.config.permissionPrompt) return null;
  return state.permissions.find((p) => p.sessionId === sessionId) || null;
}

/** Claude is on this prompt right now (the clock runs). */
function isWorking(s) {
  return s.turnStartedAt && (s.effectiveStatus === 'running' || s.effectiveStatus === 'waiting');
}

// ------------------------------------------------------------------ sound

let audio = null;
function beep(times = 1) {
  try {
    audio = audio || new AudioContext();
    const start = audio.currentTime + 0.02;
    for (let i = 0; i < times; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = i % 2 ? 660 : 880;
      const at = start + i * 0.32;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.27);
    }
  } catch {
    // no audio device
  }
}

// ------------------------------------------------------------------ animation

function statusAnimation() {
  const agg = state.aggregate;
  if (state.chat.busy && (agg.status === 'idle' || agg.status === 'ready')) return 'running';
  switch (agg.status) {
    case 'waiting':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'running':
      return agg.activity === 'reading' || agg.activity === 'web' ? 'review' : 'running';
    default:
      return 'idle';
  }
}

function playStatus() {
  if (state.temporary) return;
  sprite.play(statusAnimation(), { status: state.aggregate.status });
}

function playOnce(name, loops = 1) {
  state.temporary = name;
  sprite.play(name, {
    loops,
    onDone: () => {
      state.temporary = null;
      playStatus();
    },
  });
}

let toastTimer = 0;
function showToast(title, sub, ms = 6000, { sticky = false } = {}) {
  // an alarm stays until it's clicked; small talk doesn't push it away
  if (state.toast && state.toast.sticky && !sticky) return;
  clearTimeout(toastTimer);
  state.toast = { title, sub, sticky };
  if (!sticky)
    toastTimer = setTimeout(() => {
      state.toast = null;
      render();
    }, ms);
  render();
}

function dismissToast() {
  if (!state.toast) return false;
  clearTimeout(toastTimer);
  state.toast = null;
  render();
  return true;
}

/** A line from the pet (greetings, alarms, summaries). */
function say(text, { duration = 6000, sticky = false } = {}) {
  if (text) showToast(text, '', duration, { sticky });
}

function digestSummary(counts) {
  return ['ready', 'waiting', 'failed']
    .filter((k) => counts && counts[k] > 0)
    .map((k) => t(`digest.${k}`, { n: counts[k] }))
    .join(t('digest.separator'));
}

// ------------------------------------------------------------------ rendering

function applyI18n() {
  document.documentElement.lang = state.config.language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  ui.bubblePause.title = t('ui.pause');
}

function permissionButtons(perm, className) {
  const box = el('div', className);
  box.appendChild(button(t('perm.allow'), () => api.answerPermission(perm.id, 'allow'), 'pill-button allow'));
  box.appendChild(button(t('perm.deny'), () => api.answerPermission(perm.id, 'deny'), 'pill-button deny'));
  box.appendChild(button(t('perm.terminal'), () => api.answerPermission(perm.id, null), 'text-button muted'));
  const seconds = Math.max(0, Math.ceil((perm.expiresAt - Date.now()) / 1000));
  const left = el('span', 'perm-left', t('perm.remaining', { n: seconds }));
  left.dataset.expires = String(perm.expiresAt);
  box.appendChild(left);
  return box;
}

function permissionBox(perm) {
  const box = el('div', 'perm-box');
  box.appendChild(el('div', 'section-title', t('perm.title')));
  box.appendChild(el('div', 'perm-tool', perm.tool ? `${perm.toolName}: ${perm.tool}` : perm.toolName || ''));
  box.appendChild(permissionButtons(perm, 'perm-row'));
  return box;
}

function hideBubbleExtras() {
  ui.bubbleClock.hidden = true;
  delete ui.bubbleClock.dataset.since;
  ui.bubblePause.hidden = true;
  ui.bubbleActions.hidden = true;
  ui.bubbleProgress.hidden = true;
}

function renderBubble() {
  const agg = state.aggregate;
  const s = agg.primary;
  const visible = state.config.showBubble && !state.config.mini && !state.panelOpen;
  // a permission prompt answered from the pet comes before everything else
  const perm = visible && s && s.effectiveStatus === 'waiting' ? pendingPermission(s.id) : null;
  // a message for you shows even with the list open (in the input when that is open); alarms show in mini too
  const toast = state.toast && !perm && !state.composerOpen && (!state.config.mini || state.toast.sticky);
  if (toast) {
    hideBubbleExtras();
    ui.bubble.hidden = false;
    ui.bubble.className = `bubble status-idle toast${state.toast.sticky ? ' sticky' : ''}`;
    ui.bubbleTitle.textContent = state.toast.title;
    ui.bubbleSub.replaceChildren(document.createTextNode(state.toast.sub || ''));
    ui.bubbleSub.hidden = !state.toast.sub;
    return;
  }
  // おやすみモード and a pomodoro focus keep finished work quiet
  const show = visible && s && agg.status !== 'idle' && (!held(agg.status) || Boolean(perm));
  ui.bubble.hidden = !show;
  if (!show) return;
  ui.bubble.className = `bubble status-${agg.status}`;
  const others = attentionCount() + (agg.counts.running || 0) - 1;
  ui.bubbleTitle.textContent = `${sessionName(s)} · ${activityText(s)}`;
  ui.bubbleClock.hidden = !isWorking(s);
  if (isWorking(s)) {
    ui.bubbleClock.dataset.since = String(s.turnStartedAt);
    ui.bubbleClock.textContent = PetTime.formatClock(Date.now() - s.turnStartedAt);
  } else delete ui.bubbleClock.dataset.since;
  ui.bubblePause.hidden = !(s.effectiveStatus === 'running' && !s.pauseRequested && s.source === 'cli');
  const detail = detailText(s);
  ui.bubbleSub.replaceChildren(document.createTextNode(detail));
  if (others > 0) ui.bubbleSub.appendChild(el('span', 'bubble-more', t('bubble.more', { n: others })));
  ui.bubbleSub.hidden = !ui.bubbleSub.textContent;
  ui.bubbleActions.hidden = !perm;
  if (perm) ui.bubbleActions.replaceChildren(permissionButtons(perm, 'perm-row'));
  const progress = s.todoProgress && s.effectiveStatus !== 'idle' ? s.todoProgress : null;
  ui.bubbleProgress.hidden = !progress;
  if (progress) ui.bubbleProgressFill.style.width = `${(progress.done / progress.total) * 100}%`;
}

function moodIcon() {
  const m = state.modes || {};
  if (m.away) return ['💤', t('mode.away')];
  if (m.dnd) return ['🔕', t('mode.dnd')];
  if (m.focus) return ['🍅', t('mode.focus')];
  if (state.mood.tired) return ['🔋', ''];
  if (state.mood.night && state.config.greetings) return ['🌙', ''];
  return ['', ''];
}

function renderMood() {
  const [icon, title] = moodIcon();
  for (const node of [ui.mood, ui.miniMood]) {
    node.hidden = !icon;
    node.textContent = icon;
    node.title = title;
  }
  const calm = ['idle', 'ready'].includes(state.aggregate.status) && !state.chat.busy;
  ui.stage.classList.toggle('sleeping', Boolean(state.modes.away) && calm);
  ui.stage.classList.toggle('tired', state.mood.tired && !state.modes.away);
  ui.stage.classList.toggle('sleepy', state.mood.night && state.config.greetings && !state.modes.away && calm);
}

function renderBadge() {
  const count = attentionCount();
  const c = state.aggregate.counts || {};
  const status = c.waiting ? 'waiting' : c.failed ? 'failed' : 'ready';
  for (const badge of [ui.badge, ui.miniBadge]) {
    badge.hidden = count === 0;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.className = `${badge === ui.miniBadge ? 'badge mini-badge' : 'badge'} status-${status}`;
  }
}

function renderMini() {
  const mini = state.config.mini;
  ui.mini.hidden = !mini;
  ui.stage.hidden = mini;
  if (!mini) return;
  const agg = state.aggregate;
  ui.mini.className = `mini status-${agg.status}`;
  const running = agg.counts.running || 0;
  ui.miniLabel.textContent =
    running > 1 && agg.status === 'running' ? `${t('status.running')} · ${running}` : t(`status.${agg.status}`);
}

function sessionActions(s) {
  const actions = el('div', 'session-actions');
  const add = (label, handler) => {
    const b = el('button', 'text-button', label);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      handler(b);
    });
    actions.appendChild(b);
  };
  // Claude Code in a terminal on this computer stops at its next tool call
  if (s.effectiveStatus === 'running' && s.source === 'cli') {
    if (s.pauseRequested) add(t('ui.cancelPause'), () => api.cancelPause(s.id));
    else add(t('ui.pause'), () => api.pauseSession(s.id));
  }
  if (s.unread || s.effectiveStatus === 'failed') add(t('ui.markRead'), () => api.markRead(s.id));
  // cloud sessions and browser chats live on claude.ai, not on this computer
  if (s.url && s.source === 'cloud') add(t('ui.openInApp'), () => api.openUrl(s.url, true));
  if (s.url) add(t('ui.openInBrowser'), () => api.openUrl(s.url));
  else if (s.source !== 'cloud' && s.source !== 'browser') {
    add(t('ui.continueHere'), () => continueInChat(s.id));
    add(t('ui.openInApp'), () => openInApp(s.id, s.cwd));
    add(t('ui.openTerminal'), async (b) => {
      b.disabled = true;
      const res = await api.openTerminal(s.id, s.cwd);
      b.disabled = false;
      if (!res.ok) b.textContent = res.error;
    });
  }
  add(t('ui.copy'), (b) => {
    api.copy(s.message || s.detail || '');
    b.textContent = t('ui.copied');
  });
  add(t('ui.dismiss'), () => api.dismiss(s.id));
  return actions;
}

/** Working time, Claude's to-do progress and changed files, under the title. */
function sessionMeta(s) {
  const meta = el('div', 'session-meta');
  if (isWorking(s)) {
    const clock = el('span', 'chip', PetTime.formatClock(Date.now() - s.turnStartedAt));
    clock.dataset.since = String(s.turnStartedAt);
    meta.appendChild(clock);
  } else if (s.lastDuration != null) {
    meta.appendChild(el('span', 'chip', t('ui.took', { time: PetTime.formatSpan(s.lastDuration, state.config.language) })));
  }
  if (s.todoProgress) {
    const p = s.todoProgress;
    const chip = el('span', 'chip todo-chip', t('ui.todoProgress', { done: p.done, total: p.total }));
    const bar = el('span', 'mini-bar');
    const fill = el('span', 'mini-bar-fill');
    fill.style.width = `${(p.done / p.total) * 100}%`;
    bar.appendChild(fill);
    chip.appendChild(bar);
    meta.appendChild(chip);
  }
  if (s.files && s.files.length) meta.appendChild(el('span', 'chip', `📝 ${s.files.length}`));
  return meta.children.length ? meta : null;
}

function todoList(s) {
  const box = el('div', 'session-section');
  box.appendChild(el('div', 'section-title', `${t('ui.todos')} · ${s.todoProgress.done}/${s.todoProgress.total}`));
  const list = el('ul', 'todo-list');
  for (const todo of s.todos) {
    const item = el('li', `todo status-${todo.status}`);
    item.appendChild(el('span', 'todo-mark', todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▶' : '○'));
    item.appendChild(el('span', 'todo-text', todo.status === 'in_progress' && todo.active ? todo.active : todo.text));
    list.appendChild(item);
  }
  box.appendChild(list);
  return box;
}

function fileList(s) {
  const box = el('div', 'session-section');
  box.appendChild(el('div', 'section-title', t('ui.files', { n: s.files.length })));
  const list = el('ul', 'file-list');
  for (const file of s.files) {
    const item = el('li', 'file');
    const open = button('', () => api.openFile(s.id, file), 'file-open');
    open.title = file;
    open.appendChild(el('span', 'file-name', basename(file)));
    const dir = dirname(file);
    if (dir) open.appendChild(el('span', 'file-dir', dir));
    item.appendChild(open);
    const reveal = button('📂', () => api.openFile(s.id, file, true), 'icon-button small');
    reveal.title = t('ui.revealFile');
    item.appendChild(reveal);
    list.appendChild(item);
  }
  box.appendChild(list);
  return box;
}

function renderSessions() {
  const list = ui.sessionList;
  list.replaceChildren();
  // newest first, like a chat history
  const sessions = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  ui.sessionsEmpty.hidden = sessions.length > 0;
  ui.setupHint.hidden = state.hooksInstalled;

  const count = attentionCount();
  const c = state.aggregate.counts || {};
  ui.sessionsCount.textContent = count ? String(count) : '';
  ui.sessionsCount.className = `tab-count status-${c.waiting ? 'waiting' : c.failed ? 'failed' : 'ready'}`;

  for (const s of sessions) {
    const item = el('li', `session status-${s.effectiveStatus}`);
    if (s.unread) item.classList.add('unread');
    const expanded = state.expanded === s.id;
    if (expanded) item.classList.add('expanded');

    const row = el('button', 'session-row');
    row.type = 'button';
    row.appendChild(el('span', 'dot'));
    const main = el('div', 'session-main');
    const name = el('div', 'session-name');
    name.appendChild(el('span', 'name', `${SOURCE_MARK[s.source] || ''}${sessionName(s)}`));
    name.appendChild(el('span', 'session-time', timeAgo(s.updatedAt)));
    main.appendChild(name);
    const meta = sessionMeta(s);
    if (meta) main.appendChild(meta);
    row.title = s.project ? `${sessionName(s)}\n${s.project}` : sessionName(s);
    row.appendChild(main);
    const toggle = () => {
      state.expanded = expanded ? null : s.id;
      if (!expanded && s.effectiveStatus === 'ready') api.markRead(s.id);
      renderPanel();
    };
    // a conversation on this computer opens in full here; a cloud session opens in the Claude
    // app and a browser chat in the browser; a cloud row without a link only has its summary
    row.addEventListener('click', () => {
      if (s.effectiveStatus === 'ready') api.markRead(s.id);
      if (s.source === 'browser') return s.url ? api.openUrl(s.url) : toggle();
      if (s.source === 'cloud' && !s.url) return toggle(); // e.g. the relay test: nothing to open
      continueInChat(s.id);
    });
    item.appendChild(row);
    const more = el('button', 'icon-button session-more', expanded ? '▴' : '⋯');
    more.type = 'button';
    more.title = t('ui.moreActions');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    item.appendChild(more);

    // 許可 / 拒否 right in the list, without opening the row
    const perm = s.effectiveStatus === 'waiting' ? pendingPermission(s.id) : null;
    if (perm && !expanded) item.appendChild(permissionButtons(perm, 'perm-row in-list'));

    if (expanded) {
      const body = el('div', 'session-body');
      const detail = detailText(s);
      body.appendChild(el('div', 'session-detail', detail ? `${activityText(s)} — ${detail}` : activityText(s)));
      if (perm) body.appendChild(permissionBox(perm));
      if (s.prompt) {
        const box = el('div', 'session-text');
        box.appendChild(el('span', 'who', t('ui.you')));
        box.appendChild(document.createTextNode(s.prompt));
        body.appendChild(box);
      }
      const reply = s.message || s.detail;
      if (reply) {
        const box = el('div', 'session-text');
        box.appendChild(el('span', 'who', t('ui.claude')));
        box.appendChild(markdown(el('div', 'md'), reply));
        body.appendChild(box);
      }
      if (s.todos && s.todos.length) body.appendChild(todoList(s));
      if (s.files && s.files.length) body.appendChild(fileList(s));
      body.appendChild(sessionActions(s));
      item.appendChild(body);
    }
    list.appendChild(item);
    if (expanded) requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));
  }
}

function markdown(node, text) {
  return PetMarkdown.render(node, text, {
    onLink: (url) => api.openLink(url),
    onCopy: (code) => api.copy(code),
    labels: { copy: t('ui.copyCode'), copied: t('ui.copied') },
  });
}

function renderChat() {
  const log = ui.chatLog;
  log.replaceChildren();
  for (const m of state.chat.messages) {
    const bubble = el('div', `msg ${m.role}${m.pending ? ' pending' : ''}${m.error ? ' error' : ''}`);
    // Claude's replies are Markdown; what you wrote stays as typed
    const text = m.role === 'assistant' && !m.error ? markdown(el('div', 'text md'), m.text) : el('span', 'text', m.text);
    text.dataset.placeholder = t('ui.waitingAnswer');
    bubble.appendChild(text);
    if (m.files && m.files.length) bubble.appendChild(el('div', 'msg-files', m.files.map((f) => `📎 ${f}`).join('\n')));
    if (m.pending && m.tool) bubble.appendChild(el('span', 'tool', `${state.chat.target === 'cloud' ? '☁' : '🔧'} ${m.tool}`));
    log.appendChild(bubble);
  }
  if (!state.chat.messages.length) log.appendChild(el('p', 'empty', placeholder(state.chat.target)));
  // `claude -p` asks through the same hook, so its permission prompts can be answered here
  const perm = state.chat.sessionId ? pendingPermission(state.chat.sessionId) : null;
  if (perm) log.appendChild(permissionBox(perm));
  log.scrollTop = log.scrollHeight;
  ui.chatStop.hidden = !state.chat.busy;
  $('chat-terminal').disabled = state.chat.busy;
  $('chat-app').disabled = !(state.chat.sessionId || state.chat.url) || state.chat.busy;
  $('chat-app').title = t('ui.openInApp');
  $('chat-terminal').title = t('ui.openTerminal');
  $('chat-copy').disabled = !state.chat.messages.some((m) => m.role === 'assistant' && m.text);
  $('chat-memo').disabled = !state.chat.messages.some((m) => m.role === 'assistant' && m.text && !m.pending && !m.note);
}

function renderPanel() {
  ui.panel.hidden = !state.panelOpen;
  ui.timerDot.hidden = !PetTools.busy();
  if (!state.panelOpen) return;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === state.tab);
  ui.tabSessions.hidden = state.tab !== 'sessions';
  ui.tabChat.hidden = state.tab !== 'chat';
  ui.tabTools.hidden = !TOOL_TABS.has(state.tab);
  if (state.tab === 'sessions') renderSessions();
  else if (state.tab === 'chat') renderChat();
  else PetTools.render(state.tab, ui.tabTools);
}

/** What the input says, including which model answers. */
function placeholder(target) {
  const { quickChatModel: model = '', quickChatEffort: effort = 'xhigh' } = state.config;
  return t(`ui.placeholder.${target}`, { model, effort: t(`effort.${effort}`) });
}

function renderAttachments() {
  const box = $('composer-files');
  box.replaceChildren();
  box.hidden = !state.attachments.length;
  for (const file of state.attachments) {
    const chip = el('span', 'file-chip', `📎 ${basename(file)}`);
    chip.title = file;
    const x = el('button', 'chip-x', '×');
    x.type = 'button';
    x.addEventListener('click', () => {
      state.attachments = state.attachments.filter((f) => f !== file);
      render();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  }
  $('composer-attach').title = t('ui.attach');
  $('composer-attach').hidden = state.cloning;
}

function addAttachments(files) {
  for (const file of files) if (file && !state.attachments.includes(file)) state.attachments.push(file);
  render();
}

function renderComposer() {
  ui.composer.hidden = !state.composerOpen;
  if (!state.composerOpen) return;
  const cwd = state.chat.cwd || state.config.quickChatCwd;
  const target = state.chat.target;
  ui.composerCwd.textContent = `📁 ${cwd === state.config.home ? '~' : basename(cwd)}`;
  ui.composerCwd.title = `${t('ui.cwd')}: ${cwd}`;
  ui.composerCwd.hidden = target === 'chat'; // a normal chat has no folder
  ui.composerTarget.value = target;
  ui.composerTarget.hidden = state.cloning;
  const shot = state.attachments.some((f) => state.screenshots.has(f));
  ui.composerInput.placeholder = state.cloning ? t('ui.clonePlaceholder') : shot ? t('ui.askAboutShot') : placeholder(target);
  ui.composerSend.disabled = state.chat.busy;
  renderRepos();
  const notice = $('composer-notice');
  notice.hidden = !state.toast;
  notice.textContent = state.toast ? [state.toast.title, state.toast.sub].filter(Boolean).join(' — ') : '';
  renderAttachments();
}

function render() {
  renderMini();
  renderBadge();
  renderMood();
  renderBubble();
  renderPanel();
  renderComposer();
  reportSize();
}

let sizeFrame = 0;
function reportSize() {
  cancelAnimationFrame(sizeFrame);
  sizeFrame = requestAnimationFrame(() => {
    const rect = ui.root.getBoundingClientRect();
    api.resize(rect.width, rect.height);
  });
}

new ResizeObserver(reportSize).observe(ui.root);

// ------------------------------------------------------------------ panel & chat

function openPanel(tab) {
  state.panelOpen = true;
  if (tab) state.tab = tab;
  render();
}

function closePanel() {
  state.panelOpen = false;
  state.expanded = null;
  // an empty quick-chat box goes away with the panel
  if (!state.chat.busy && !ui.composerInput.value.trim()) state.composerOpen = false;
  render();
}

function togglePanel() {
  if (state.panelOpen) closePanel();
  else openPanel(state.chat.messages.length && state.chat.busy ? 'chat' : 'sessions');
}

function openComposer() {
  state.composerOpen = true;
  render();
  api.focus();
  setTimeout(() => ui.composerInput.focus(), 30);
}

function closeComposer() {
  state.composerOpen = false;
  render();
}

/** Load a past conversation into the quick chat; what you send next continues it. */
async function continueInChat(id) {
  if (state.chat.sessionId !== id && state.chat.openedFrom !== id) {
    if (state.chat.busy) return showToast(t('ui.chatBusy'));
    const res = await api.openChat(id);
    if (!res.ok) return showToast(t('ui.chatNotFound'), res.error);
    const base = { messages: res.messages, busy: false, openedFrom: id };
    state.chat = res.cloud
      ? // a cloud session: what you send next goes to it (claude -p --cloud)
        { ...base, sessionId: null, cwd: state.chat.cwd, target: 'cloud', cloudId: res.cloudId, url: res.url }
      : { ...base, sessionId: id, cwd: res.cwd || state.chat.cwd, target: 'local', cloudId: null, url: null };
  }
  openPanel('chat');
  openComposer();
}

async function openInApp(id, cwd) {
  const res = await api.openDesktop(id, cwd);
  if (!res.ok) showToast(t('ui.appFailed'), res.error);
}

/** Put a memo into the quick chat input, ready to edit and send (in the memo's folder). */
function sendToChat(text, cwd) {
  if (cwd && state.chat.target === 'local' && !state.chat.busy && cwd !== (state.chat.cwd || state.config.quickChatCwd)) {
    setFolder(cwd);
  }
  ui.composerInput.value = text;
  openPanel('chat');
  openComposer();
}

function newChat() {
  if (state.chat.busy) api.quickStop();
  state.chat = {
    messages: [],
    sessionId: null,
    cwd: state.chat.cwd,
    busy: false,
    target: state.chat.target,
    cloudId: null,
    url: null,
  };
  openPanel('chat');
  openComposer();
}

function setTarget(target) {
  api.setQuickTarget(target);
  if (target === state.chat.target) return;
  // a conversation stays where it started; switching starts a new one
  if (state.chat.messages.length) newChat();
  state.chat.target = target;
  render();
  // the cloud needs a repository; offer yours when none is chosen yet
  const cwd = state.chat.cwd || state.config.quickChatCwd;
  if (target === 'cloud' && (!cwd || cwd === state.config.home)) chooseWhere();
}

async function chooseWhere() {
  const current = state.chat.cwd || state.config.quickChatCwd;
  // a cloud task works on a GitHub repository: go straight to your repositories
  const pick = state.chat.target === 'cloud' ? { clone: true } : await api.folderMenu(current);
  let folder = pick && pick.dir;
  if (pick && pick.choose) {
    folder = await api.chooseFolder(current);
  }
  if (pick && pick.clone) {
    state.cloning = true;
    ui.composerInput.value = '';
    state.repos = { loading: !state.repos.list.length, list: state.repos.list, index: 0 };
    render();
    ui.composerInput.focus();
    const res = await api.listRepos();
    state.repos = { loading: false, list: res.ok ? res.repos : [], index: 0 };
    if (!res.ok) showToast(t('ui.reposFailed'), res.error);
    render();
    return;
  }
  if (folder) setFolder(folder);
}

function setFolder(folder) {
  if (folder !== state.chat.cwd) {
    // another folder (repository) means another conversation
    if (state.chat.messages.length) newChat();
    state.chat.sessionId = null;
    state.chat.cloudId = null;
  }
  state.chat.cwd = folder;
  render();
}

/** Your repositories that match what is typed, most recently pushed first. */
function matchingRepos() {
  const q = ui.composerInput.value.trim().toLowerCase();
  return state.repos.list.filter((r) => !q || r.fullName.toLowerCase().includes(q)).slice(0, 8);
}

function renderRepos() {
  const box = $('composer-repos');
  box.replaceChildren();
  box.hidden = !state.cloning;
  if (!state.cloning) return;
  if (state.repos.loading) return box.appendChild(el('div', 'repo-note', t('ui.reposLoading')));
  const repos = matchingRepos();
  if (!repos.length && state.repos.list.length) box.appendChild(el('div', 'repo-note', t('ui.reposNone')));
  repos.forEach((r, i) => {
    const item = el('button', `repo-item${i === state.repos.index ? ' active' : ''}`);
    item.type = 'button';
    item.appendChild(el('span', 'repo-name', `${r.private ? '🔒 ' : ''}${r.fullName}`));
    if (r.cloned) item.appendChild(el('span', 'repo-badge', t('ui.repoCloned')));
    if (r.description) item.appendChild(el('span', 'repo-desc', r.description));
    item.addEventListener('mousedown', (e) => e.preventDefault()); // keep the input focused
    item.addEventListener('click', () => pickRepo(r.fullName));
    box.appendChild(item);
  });
}

function pickRepo(fullName) {
  ui.composerInput.value = fullName;
  cloneFromComposer();
}

async function cloneFromComposer() {
  const text = ui.composerInput.value.trim();
  if (!text) return;
  ui.composerSend.disabled = true;
  showToast(t('ui.cloning'), text, 60000);
  const res = await api.cloneRepo(text);
  state.toast = null;
  if (!res.ok) {
    ui.composerSend.disabled = false;
    return showToast(t('ui.cloneFailed'), res.error);
  }
  state.cloning = false;
  ui.composerInput.value = '';
  setFolder(res.dir);
  showToast(t('ui.cloned'), res.dir);
}

async function sendQuick() {
  if (state.cloning) return cloneFromComposer();
  const files = state.attachments.slice();
  // files on this computer can only go to Claude Code running here
  if (files.length && state.chat.target !== 'local') return showToast(t('ui.filesLocalOnly'));
  const shot = files.some((f) => state.screenshots.has(f));
  const prompt = ui.composerInput.value.trim() || (shot ? t('ui.defaultShotPrompt') : files.length ? t('ui.lookAtFiles') : '');
  if (!prompt || state.chat.busy) return;
  // a conversation that is working elsewhere (a terminal, the app) can be read but not answered here
  const live = state.sessions.find((s) => s.id === state.chat.sessionId && s.source !== 'quickchat');
  if (live && (live.effectiveStatus === 'running' || live.effectiveStatus === 'waiting')) return showToast(t('ui.busyElsewhere'));
  ui.composerInput.value = '';
  state.attachments = [];
  state.screenshots.clear();
  const chat = state.chat;
  chat.messages.push({ role: 'user', text: prompt, files: files.map(basename) });
  if (chat.target === 'chat') {
    // the answer comes in the Claude app (or claude.ai in the browser)
    const sent = await api.askInApp(prompt);
    chat.messages.push({ role: 'assistant', text: t(sent.browser ? 'ui.sentToBrowser' : 'ui.sentToApp'), note: true });
    openPanel('chat');
    return render();
  }
  chat.messages.push({ role: 'assistant', text: '', pending: true });
  chat.busy = true;
  openPanel('chat');
  playStatus();
  const cloud = chat.target === 'cloud';
  const res = await api.quickSend(
    prompt,
    chat.cwd || state.config.quickChatCwd,
    cloud ? chat.cloudId : chat.sessionId,
    cloud,
    files,
  );
  if (!res.ok) handleQuickEvent({ type: 'error', message: res.error });
  else chat.cwd = res.cwd;
  render();
}

function lastAssistant() {
  const list = state.chat.messages;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'assistant') return list[i];
  return null;
}

function handleQuickEvent(ev) {
  const chat = state.chat;
  const reply = lastAssistant();
  switch (ev.type) {
    case 'session':
      chat.sessionId = ev.sessionId;
      if (ev.cwd) chat.cwd = ev.cwd;
      break;
    case 'text':
      if (reply) reply.text = reply.text ? `${reply.text}\n\n${ev.text}` : ev.text;
      break;
    case 'raw': // a cloud run's reply as plain text, line by line
      if (reply) reply.text = reply.text ? `${reply.text}\n${ev.text}` : ev.text;
      break;
    case 'note': // progress of a cloud run
      if (reply) reply.tool = ev.text;
      break;
    case 'cloud-linked': // the cloud session a terminal started for this chat; follow-ups go to it
      if (chat.target === 'cloud' && !chat.cloudId && chat.messages.some((m) => m.role === 'user' && m.text === ev.prompt)) {
        chat.cloudId = ev.cloudSessionId;
        chat.url = ev.url;
        chat.messages.push({ role: 'assistant', text: t('ui.cloudLinked') });
      }
      break;
    case 'cloud-message': {
      // the open cloud session said something (here or in the app): show it unless it's already there
      if (!ev.cloudId || chat.cloudId !== ev.cloudId || chat.busy) break;
      const last = [...chat.messages].reverse().find((m) => m.role === ev.role);
      if (last && (last.text === ev.text || last.text.startsWith(ev.text.slice(0, 80)))) break;
      chat.messages.push({ role: ev.role, text: ev.text });
      break;
    }
    case 'interactive-only': // this Claude Code starts cloud sessions in a terminal only
      if (reply) {
        reply.text = t('ui.cloudInTerminal');
        reply.pending = false;
      }
      break;
    case 'cloud':
      chat.cloudId = ev.cloudSessionId;
      if (ev.url) chat.url = ev.url;
      break;
    case 'tool':
      if (reply) reply.tool = ev.name;
      break;
    case 'result':
      if (reply) {
        if (!reply.text && ev.text) reply.text = ev.text;
        reply.error = ev.isError;
        // an expired login can only be renewed interactively
        if (ev.isError && AUTH_ERROR.test(reply.text)) reply.text += `\n\n${t('ui.loginHint')}`;
      }
      break;
    case 'error':
      if (reply) {
        reply.text = t('ui.quickError', { error: ev.message });
        reply.error = true;
        reply.pending = false;
      }
      chat.busy = false;
      break;
    case 'done':
      if (reply) reply.pending = false;
      chat.busy = false;
      if (!state.panelOpen || state.tab !== 'chat') playOnce('jumping', 2);
      break;
    default:
      break;
  }
  playStatus();
  render();
}

// ------------------------------------------------------------------ live clocks

function tick() {
  const now = Date.now();
  for (const node of document.querySelectorAll('[data-since]')) {
    const text = PetTime.formatClock(now - Number(node.dataset.since));
    if (node.textContent !== text) node.textContent = text;
  }
  for (const node of document.querySelectorAll('[data-expires]')) {
    node.textContent = t('perm.remaining', { n: Math.max(0, Math.ceil((Number(node.dataset.expires) - now) / 1000)) });
  }
  if (state.panelOpen && state.tab === 'timer') PetTools.tick(now);
}

// ------------------------------------------------------------------ greetings: time of day, battery, coming back

const greet = { morningDay: null, nightAt: 0, warned10: false };

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
  return null;
}

function checkTimeOfDay() {
  const now = new Date();
  const hour = now.getHours();
  const night = hour >= 23 || hour < 5;
  if (night !== state.mood.night) {
    state.mood.night = night;
    renderMood();
  }
  if (!state.config.greetings || state.modes.away || state.modes.dnd || state.config.mini) return;
  const day = now.toDateString();
  if (greet.morningDay == null) greet.morningDay = storage('pet.morningDay');
  if (hour >= 5 && hour < 11 && greet.morningDay !== day) {
    greet.morningDay = day;
    storage('pet.morningDay', day);
    say(t('say.morning'), { duration: 7000 });
    playOnce('waving', 2);
  } else if (night && Date.now() - greet.nightAt > 60 * 60e3) {
    greet.nightAt = Date.now();
    say(t('say.night'), { duration: 9000 });
  }
}

async function watchBattery() {
  if (!navigator.getBattery) return;
  let battery;
  try {
    battery = await navigator.getBattery();
  } catch {
    return;
  }
  const update = () => {
    const level = Math.round(battery.level * 100);
    const low = !battery.charging && level <= 20;
    if (low && !state.mood.tired) {
      state.mood.tired = true;
      if (state.config.greetings) say(t('say.batteryLow', { level }), { duration: 9000 });
    } else if (low && level <= 10 && !greet.warned10) {
      greet.warned10 = true;
      if (state.config.greetings) say(t('say.batteryLow', { level }), { duration: 9000 });
    } else if (!low && state.mood.tired) {
      state.mood.tired = false;
      greet.warned10 = false;
      if (battery.charging && state.config.greetings) say(t('say.charging'), { duration: 5000 });
    }
    renderMood();
  };
  battery.addEventListener('levelchange', update);
  battery.addEventListener('chargingchange', update);
  update();
}

/** What happened while you were away, focusing, or in おやすみモード. */
function handleDigest(d) {
  const summary = digestSummary(d.counts);
  if (d.reason === 'away') {
    if (!summary && !state.config.greetings) return;
    const text = summary ? t('say.awaySummary', { summary }) : d.cause === 'sleep' ? t('say.resume') : t('say.welcomeBack');
    say(text, { duration: summary ? 14000 : 6000 });
    playOnce('waving', 2);
    setTimeout(checkTimeOfDay, 7000); // good morning comes after "welcome back"
  } else if (summary) {
    say(t(d.reason === 'focus' ? 'say.focusSummary' : 'say.dndSummary', { summary }), { duration: 12000 });
  }
}

function handleAlarm(a) {
  if (a.kind === 'timer') {
    say(a.label ? t('timer.doneLabel', { label: a.label }) : t('timer.done'), { sticky: true });
    playOnce('jumping', 4);
    beep(3);
  } else if (a.kind === 'pomodoro') {
    if (a.to === 'focus') say(t('pomo.focusStart', { min: a.minutes }), { duration: 7000 });
    else if (a.to) say(t('pomo.breakStart', { min: a.minutes }), { duration: 10000 });
    else say(t('pomo.finished'), { duration: 4000 });
    if (a.from) {
      playOnce(a.to === 'focus' ? 'waving' : 'jumping', 2);
      beep(a.to === 'focus' ? 1 : 2);
    }
  } else if (a.kind === 'calendar') {
    say(t('cal.reminder', { min: a.minutes, title: a.title || t('cal.untitled') }), { duration: 30000 });
    playOnce('waving', 3);
    beep(1);
  }
}

// ------------------------------------------------------------------ drag & drop: feed the pet

function setupDrop() {
  let depth = 0;
  const hasPayload = (e) =>
    [...(e.dataTransfer ? e.dataTransfer.types : [])].some((type) => type === 'Files' || type === 'text/plain');
  const highlight = (on) => {
    ui.stage.classList.toggle('drop-target', on);
    ui.mini.classList.toggle('drop-target', on);
  };
  document.addEventListener('dragenter', (e) => {
    if (!hasPayload(e)) return;
    e.preventDefault();
    depth += 1;
    highlight(true);
  });
  document.addEventListener('dragover', (e) => {
    if (!hasPayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) highlight(false);
  });
  document.addEventListener('drop', (e) => {
    depth = 0;
    highlight(false);
    // the input has its own drop handling (files are attached, text is typed)
    if (ui.composer.contains(e.target) || e.defaultPrevented) return;
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
    const text = files.length ? '' : (e.dataTransfer.getData('text/plain') || '').trim();
    if (!files.length && !text) return;
    if (text) ui.composerInput.value = ui.composerInput.value ? `${ui.composerInput.value}\n\n${text}` : text;
    if (!state.config.mini) playOnce('jumping', 1);
    openPanel('chat');
    openComposer();
    if (files.length) addAttachments(files);
    say(t('say.fed'), { duration: 3000 });
  });
}

// ------------------------------------------------------------------ pointer: click vs drag

function setupPointer(target) {
  let start = null;
  let dragging = false;
  let lastX = 0;

  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    start = { x: e.screenX, y: e.screenY };
    lastX = e.screenX;
    dragging = false;
    target.setPointerCapture(e.pointerId);
  });

  target.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.screenX - start.x;
    const dy = e.screenY - start.y;
    if (!dragging && Math.hypot(dx, dy) > 4) {
      dragging = true;
      target.classList.add('dragging');
      api.dragStart(start.x, start.y);
    }
    if (!dragging) return;
    api.dragMove(e.screenX, e.screenY);
    if (!state.config.mini && Math.abs(e.screenX - lastX) > 1) {
      const dir = e.screenX > lastX ? 'running-right' : 'running-left';
      if (state.temporary !== dir) {
        state.temporary = dir;
        sprite.play(dir);
      }
      lastX = e.screenX;
    }
  });

  const end = (e) => {
    if (!start) return;
    target.releasePointerCapture(e.pointerId);
    const wasDragging = dragging;
    start = null;
    dragging = false;
    target.classList.remove('dragging');
    if (wasDragging) {
      api.dragEnd();
      state.temporary = null;
      playStatus();
      return;
    }
    if (state.toast && state.toast.sticky) return void dismissToast();
    if (!state.config.mini) playOnce('waving', 2);
    togglePanel();
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
  target.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.contextMenu();
  });
}

// ------------------------------------------------------------------ wiring

function setupControls() {
  setupPointer(ui.stage);
  setupPointer(ui.mini);
  setupDrop();
  // a click on what the pet says puts it away; on a session it opens the list
  ui.bubble.addEventListener('click', () => {
    if (!ui.bubble.classList.contains('toast') || !dismissToast()) openPanel('sessions');
  });
  ui.bubblePause.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = state.aggregate.primary;
    if (s) api.pauseSession(s.id);
  });
  ui.bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.contextMenu();
  });
  $('panel-close').addEventListener('click', closePanel);
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      if (state.tab === 'chat') openComposer();
      render();
    });
  }
  $('mark-all').addEventListener('click', () => api.markAllRead());
  $('new-chat').addEventListener('click', newChat);
  $('chat-new').addEventListener('click', newChat);
  $('chat-stop').addEventListener('click', () => api.quickStop());
  $('chat-copy').addEventListener('click', (e) => {
    const reply = lastAssistant();
    if (reply) api.copy(reply.text);
    e.currentTarget.textContent = t('ui.copied');
    setTimeout(() => applyI18n(), 1200);
  });
  $('chat-memo').addEventListener('click', async (e) => {
    const reply = lastAssistant();
    if (!reply || !reply.text) return;
    const target = e.currentTarget;
    const res = await api.memo({ action: 'add', text: reply.text, cwd: state.chat.cwd || null });
    if (res && res.ok) {
      target.textContent = '✓';
      setTimeout(() => applyI18n(), 1200);
    }
  });
  $('chat-app').addEventListener('click', () => {
    if (state.chat.url)
      api.openUrl(state.chat.url, true); // a cloud task opens in the Claude app (claude.ai/code)
    else openInApp(state.chat.sessionId, state.chat.cwd);
  });
  $('chat-terminal').addEventListener('click', async () => {
    // continues this chat in Claude Code; before the first reply, a new one starts in the chosen folder
    const { sessionId, cloudId, cwd } = state.chat;
    const res = await api.openTerminal(sessionId || null, cwd || state.config.quickChatCwd, cloudId);
    if (!res.ok) showToast(t('ui.terminalFailed'), res.error);
  });

  ui.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendQuick();
  });
  ui.composerInput.addEventListener('keydown', (e) => {
    if (state.cloning && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      // move through your repositories
      e.preventDefault();
      const n = matchingRepos().length;
      if (n) state.repos.index = (state.repos.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      return renderRepos();
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const highlighted = state.cloning && matchingRepos()[state.repos.index];
      if (highlighted) return pickRepo(highlighted.fullName);
      sendQuick();
    }
  });
  ui.composerInput.addEventListener('input', () => {
    if (state.cloning) {
      state.repos.index = 0;
      renderRepos();
    }
    reportSize();
  });
  $('composer-close').addEventListener('click', closeComposer);
  ui.composerCwd.addEventListener('click', chooseWhere);
  $('composer-attach').addEventListener('click', async () => addAttachments(await api.chooseFiles()));
  // files dropped on the input, and images pasted into it
  ui.composer.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  ui.composer.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addAttachments([...e.dataTransfer.files].map((f) => api.pathForFile(f)));
  });
  ui.composerInput.addEventListener('paste', async (e) => {
    const images = [...(e.clipboardData ? e.clipboardData.items : [])].filter(
      (i) => i.kind === 'file' && i.type.startsWith('image/'),
    );
    if (!images.length) return;
    e.preventDefault();
    for (const item of images) {
      const blob = item.getAsFile();
      const file = blob && (await api.savePasted(new Uint8Array(await blob.arrayBuffer()), blob.type));
      if (file) addAttachments([file]);
    }
  });
  ui.composerTarget.addEventListener('change', () => setTarget(ui.composerTarget.value));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.toast && state.toast.sticky) dismissToast();
    else if (state.cloning) {
      state.cloning = false;
      ui.composerInput.value = '';
      render();
    } else if (state.composerOpen) closeComposer();
    else if (state.panelOpen) closePanel();
  });

  setInterval(() => {
    if (state.panelOpen && state.tab === 'sessions') renderSessions();
  }, 30000);
  setInterval(tick, 1000);
  setInterval(checkTimeOfDay, 60000);
}

function applyState({ sessions, aggregate, permissions, modes }) {
  state.sessions = sessions;
  state.aggregate = aggregate;
  state.permissions = permissions || [];
  state.modes = modes || { dnd: null, focus: false, away: false };
  if (state.expanded && !sessions.some((s) => s.id === state.expanded)) state.expanded = null;
  playStatus();
  render();
}

function applyConfig(config) {
  const scaleChanged = config.scale !== state.config.scale;
  state.config = config;
  t = PetI18n.translator(config.language);
  applyI18n();
  if (!state.chat.cwd) state.chat.cwd = config.quickChatCwd;
  if (!state.chat.messages.length && config.quickChatTarget) state.chat.target = config.quickChatTarget;
  if (scaleChanged && state.pet) sprite.setPet(state.pet, config.scale);
  render();
}

/** A timer, memo or calendar update: redraw its tab if it is the one open. */
function toolsChanged(tab) {
  if (state.panelOpen && state.tab === tab) renderPanel();
  else ui.timerDot.hidden = !PetTools.busy();
  reportSize();
}

async function boot() {
  const init = await api.init();
  state.hooksInstalled = init.hooksInstalled;
  PetTools.init({
    api,
    t: () => t,
    language: () => state.config.language,
    locale,
    sendToChat,
    copy: (text) => api.copy(text),
    rerender: () => renderPanel(),
    reportSize,
  });
  PetTools.setTimers(init.timers);
  PetTools.setMemos(init.memos);
  PetTools.setCalendar(init.calendar);
  applyConfig(init.config);
  state.pet = init.pet;
  sprite.setPet(init.pet, init.config.scale);
  if (init.pet) ui.stage.title = init.pet.displayName;
  applyState(init.state);
  setupControls();

  api.on('state', applyState);
  api.on('config', applyConfig);
  api.on('pet', (pet) => {
    state.pet = pet;
    sprite.setPet(pet, state.config.scale);
    ui.stage.title = pet.displayName;
    playOnce('waving', 2);
    if (pet.announce) showToast(pet.displayName, t('toast.arrived'));
    render();
  });
  api.on('transition', ({ to, session, held: quiet }) => {
    if (to === 'ready' && session.source !== 'quickchat' && !quiet) playOnce('jumping', 2);
  });
  api.on('command', (cmd) => {
    if (cmd.type === 'panel') openPanel(cmd.tab);
    if (cmd.type === 'quickchat') {
      openPanel('chat');
      openComposer();
    }
  });
  api.on('quick-event', handleQuickEvent);
  api.on('timers', (snapshot) => {
    PetTools.setTimers(snapshot);
    toolsChanged('timer');
  });
  api.on('memos', (list) => {
    PetTools.setMemos(list);
    toolsChanged('memo');
  });
  api.on('calendar', (snapshot) => {
    PetTools.setCalendar(snapshot);
    toolsChanged('calendar');
  });
  api.on('alarm', handleAlarm);
  api.on('digest', handleDigest);
  api.on('say', ({ text }) => say(text, { duration: 9000 }));
  // a screenshot to ask about
  api.on('attach', ({ files, kind }) => {
    for (const f of files || []) if (kind === 'screenshot') state.screenshots.add(f);
    openPanel('chat');
    openComposer();
    addAttachments(files || []);
  });
  playOnce('waving', 2);
  checkTimeOfDay();
  watchBattery();
}

boot();
