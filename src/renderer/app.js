'use strict';

/* global PetI18n, PetSprite, PetTime, PetMarkdownView, PetTools */

const api = window.pet;
const $ = (id) => document.getElementById(id);

const ui = {
  root: $('root'),
  panel: $('panel'),
  speech: $('speech'),
  speechText: $('speech-text'),
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
  composerFiles: $('composer-files'),
  composerInput: $('composer-input'),
  composerCwd: $('composer-cwd'),
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
  permissions: [],
  modes: { dnd: null, focus: false, away: false },
  hooksInstalled: true,
  panelOpen: false,
  tab: 'sessions',
  expanded: null,
  composerOpen: false,
  chat: { messages: [], sessionId: null, cwd: '', busy: false },
  attachments: [], // { path, name, kind: 'file' | 'screenshot' }
  speech: null, // { text, sticky, until }
  mood: { night: false, tired: false },
  temporary: null, // a one-off animation (wave, jump) that overrides the status animation
};

let t = PetI18n.translator('ja');

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

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function dirname(p) {
  const parts = String(p || '')
    .split(/[\\/]/)
    .filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
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
  return t('ui.hoursAgo', { n: Math.floor(minutes / 60) });
}

function locale() {
  return state.config.language === 'en' ? 'en-US' : 'ja-JP';
}

function sessionName(s) {
  return s.title || s.project || s.id.slice(0, 8);
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

/** Same rule as the main process: what おやすみモード / focus keeps out of the bubble. */
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

function isWorking(s) {
  return s.turnStartedAt && (s.effectiveStatus === 'running' || s.effectiveStatus === 'waiting');
}

function markdown(text) {
  return PetMarkdownView.render(text, {
    onLink: (url) => api.openExternal(url),
    onCopy: (code) => api.copy(code),
    copyLabel: t('ui.copyCode'),
    copiedLabel: t('ui.copied'),
  });
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
  sprite.play(statusAnimation());
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

// ------------------------------------------------------------------ speech

/** A short message from the pet. Sticky ones (alarms) stay until clicked. */
function say(text, { duration = 6000, sticky = false } = {}) {
  if (!text) return;
  if (state.speech && state.speech.sticky && !sticky) return;
  state.speech = { text, sticky, until: Date.now() + duration };
  render();
}

function dismissSpeech() {
  if (!state.speech) return;
  state.speech = null;
  render();
}

function digestSummary(counts) {
  const parts = ['ready', 'waiting', 'failed']
    .filter((k) => counts && counts[k] > 0)
    .map((k) => t(`digest.${k}`, { n: counts[k] }));
  return parts.join(t('digest.separator'));
}

// ------------------------------------------------------------------ rendering

function applyI18n() {
  document.documentElement.lang = state.config.language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  renderComposerPlaceholder();
  ui.composerCwd.title = t('ui.cwd');
  ui.bubblePause.title = t('ui.pause');
}

function permissionButtons(perm, className) {
  const box = el('div', className);
  box.appendChild(button(t('perm.allow'), () => api.answerPermission(perm.id, 'allow'), 'pill-button allow'));
  box.appendChild(button(t('perm.deny'), () => api.answerPermission(perm.id, 'deny'), 'pill-button deny'));
  box.appendChild(button(t('perm.terminal'), () => api.answerPermission(perm.id, null), 'text-button muted'));
  const left = el('span', 'perm-left', t('perm.remaining', { n: Math.max(0, Math.ceil((perm.expiresAt - Date.now()) / 1000)) }));
  left.dataset.expires = String(perm.expiresAt);
  box.appendChild(left);
  return box;
}

function renderSpeech() {
  const sp = state.speech;
  const visible = Boolean(sp) && (sp.sticky || (!state.panelOpen && !state.config.mini));
  ui.speech.hidden = !visible;
  if (visible) {
    ui.speechText.textContent = sp.text;
    ui.speech.classList.toggle('sticky', sp.sticky);
  }
  return visible;
}

function renderBubble(speechVisible) {
  const agg = state.aggregate;
  const s = agg.primary;
  const perm = s && s.effectiveStatus === 'waiting' ? pendingPermission(s.id) : null;
  const show =
    state.config.showBubble &&
    !state.config.mini &&
    !state.panelOpen &&
    s &&
    agg.status !== 'idle' &&
    !held(agg.status) &&
    (!speechVisible || Boolean(perm));
  ui.bubble.hidden = !show;
  if (!show) return;
  ui.bubble.className = `bubble status-${agg.status}`;
  const others = attentionCount() + (agg.counts.running || 0) - 1;
  ui.bubbleTitle.textContent = `${sessionName(s)} · ${activityText(s)}`;

  if (isWorking(s)) {
    ui.bubbleClock.dataset.since = String(s.turnStartedAt);
    ui.bubbleClock.textContent = PetTime.formatClock(Date.now() - s.turnStartedAt);
    ui.bubbleClock.hidden = false;
  } else {
    delete ui.bubbleClock.dataset.since;
    ui.bubbleClock.hidden = true;
  }
  ui.bubblePause.hidden = !(s.effectiveStatus === 'running' && !s.pauseRequested && s.source !== 'quickchat');

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
    const chip = el('span', 'chip todo-chip', t('ui.todoProgress', { done: s.todoProgress.done, total: s.todoProgress.total }));
    const bar = el('span', 'mini-bar');
    const fill = el('span', 'mini-bar-fill');
    fill.style.width = `${(s.todoProgress.done / s.todoProgress.total) * 100}%`;
    bar.appendChild(fill);
    chip.appendChild(bar);
    meta.appendChild(chip);
  }
  if (s.files && s.files.length) meta.appendChild(el('span', 'chip', `📝 ${s.files.length}`));
  return meta.children.length ? meta : null;
}

function sessionActions(s) {
  const actions = el('div', 'session-actions');
  const add = (label, handler, className) => actions.appendChild(button(label, handler, className));
  if (s.effectiveStatus === 'running' && s.source !== 'quickchat') {
    if (s.pauseRequested) add(t('ui.cancelPause'), () => api.cancelPause(s.id));
    else add(t('ui.pause'), () => api.pauseSession(s.id));
  }
  if (s.unread || s.effectiveStatus === 'failed') add(t('ui.markRead'), () => api.markRead(s.id));
  add(t('ui.openTerminal'), async (b) => {
    b.disabled = true;
    const res = await api.openTerminal(s.id, s.cwd);
    b.disabled = false;
    if (!res.ok) b.textContent = res.error;
  });
  add(t('ui.copy'), (b) => {
    api.copy(s.message || s.detail || '');
    b.textContent = t('ui.copied');
  });
  add(t('ui.dismiss'), () => api.dismiss(s.id));
  return actions;
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
  const sessions = state.sessions;
  ui.sessionsEmpty.hidden = sessions.length > 0;
  ui.setupHint.hidden = state.hooksInstalled;

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
    name.appendChild(el('span', 'name', `${s.source === 'quickchat' ? '💬 ' : ''}${sessionName(s)}`));
    name.appendChild(el('span', 'session-time', timeAgo(s.updatedAt)));
    main.appendChild(name);
    const detail = detailText(s);
    main.appendChild(el('div', 'session-detail', detail ? `${activityText(s)} — ${detail}` : activityText(s)));
    const meta = sessionMeta(s);
    if (meta) main.appendChild(meta);
    row.appendChild(main);
    row.addEventListener('click', () => {
      state.expanded = expanded ? null : s.id;
      if (!expanded && s.effectiveStatus === 'ready') api.markRead(s.id);
      renderPanel();
    });
    item.appendChild(row);

    const perm = s.effectiveStatus === 'waiting' ? pendingPermission(s.id) : null;
    if (perm && !expanded) item.appendChild(permissionButtons(perm, 'perm-row in-list'));

    if (expanded) {
      const body = el('div', 'session-body');
      if (perm) {
        const box = el('div', 'perm-box');
        box.appendChild(el('div', 'section-title', t('perm.title')));
        box.appendChild(el('div', 'perm-tool', perm.tool ? `${perm.toolName}: ${perm.tool}` : perm.toolName || ''));
        box.appendChild(permissionButtons(perm, 'perm-row'));
        body.appendChild(box);
      }
      if (s.prompt) {
        const box = el('div', 'session-text');
        box.appendChild(el('span', 'who', t('ui.you')));
        box.appendChild(document.createTextNode(s.prompt));
        body.appendChild(box);
      }
      const reply = s.message || s.detail;
      if (reply) {
        const box = el('div', 'session-text rich');
        box.appendChild(el('span', 'who', t('ui.claude')));
        box.appendChild(s.message ? markdown(s.message) : document.createTextNode(reply));
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

function renderChat() {
  const log = ui.chatLog;
  log.replaceChildren();
  for (const m of state.chat.messages) {
    const bubble = el('div', `msg ${m.role}${m.pending ? ' pending' : ''}${m.error ? ' error' : ''}`);
    if (m.role === 'assistant' && m.text && !m.error) {
      bubble.classList.add('rich');
      bubble.appendChild(markdown(m.text));
    } else {
      const text = el('span', 'text', m.text);
      text.dataset.placeholder = t('ui.waitingAnswer');
      bubble.appendChild(text);
    }
    if (m.files && m.files.length) bubble.appendChild(el('span', 'msg-files', m.files.map((f) => `📎 ${f}`).join('  ')));
    if (m.pending && m.tool) bubble.appendChild(el('span', 'tool', `🔧 ${m.tool}`));
    log.appendChild(bubble);
  }
  if (!state.chat.messages.length) log.appendChild(el('p', 'empty', t('ui.quickPlaceholder')));
  // `claude -p` asks through the same hook, so its permission requests can be answered here.
  const perm = state.chat.sessionId ? pendingPermission(state.chat.sessionId) : null;
  if (perm) {
    const box = el('div', 'perm-box');
    box.appendChild(el('div', 'section-title', t('perm.title')));
    box.appendChild(el('div', 'perm-tool', perm.tool ? `${perm.toolName}: ${perm.tool}` : perm.toolName || ''));
    box.appendChild(permissionButtons(perm, 'perm-row'));
    log.appendChild(box);
  }
  log.scrollTop = log.scrollHeight;
  ui.chatStop.hidden = !state.chat.busy;
  const hasReply = state.chat.messages.some((m) => m.role === 'assistant' && m.text && !m.pending);
  $('chat-terminal').disabled = !state.chat.sessionId || state.chat.busy;
  $('chat-copy').disabled = !hasReply;
  $('chat-memo').disabled = !hasReply;
}

function renderPanel() {
  ui.panel.hidden = !state.panelOpen;
  ui.timerDot.hidden = !PetTools.busy();
  if (!state.panelOpen) return;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === state.tab);
  ui.tabSessions.hidden = state.tab !== 'sessions';
  ui.tabChat.hidden = state.tab !== 'chat';
  ui.tabTools.hidden = !TOOL_TABS.has(state.tab);

  const count = attentionCount();
  const c = state.aggregate.counts || {};
  ui.sessionsCount.textContent = count ? String(count) : '';
  ui.sessionsCount.className = `tab-count status-${c.waiting ? 'waiting' : c.failed ? 'failed' : 'ready'}`;

  if (state.tab === 'sessions') renderSessions();
  else if (state.tab === 'chat') renderChat();
  else PetTools.render(state.tab, ui.tabTools);
}

function renderComposerPlaceholder() {
  const shot = state.attachments.some((a) => a.kind === 'screenshot');
  ui.composerInput.placeholder = shot
    ? t('ui.askAboutShot')
    : state.attachments.length
      ? t('ui.askAboutFile')
      : t('ui.quickPlaceholder');
}

function renderComposer() {
  ui.composer.hidden = !state.composerOpen;
  if (!state.composerOpen) return;
  const cwd = state.chat.cwd || state.config.quickChatCwd;
  ui.composerCwd.textContent = `📁 ${cwd === state.config.home ? '~' : basename(cwd)}`;
  ui.composerSend.disabled = state.chat.busy;

  ui.composerFiles.hidden = !state.attachments.length;
  ui.composerFiles.replaceChildren();
  state.attachments.forEach((a, index) => {
    const chip = el('span', 'attachment');
    chip.title = a.path;
    chip.appendChild(el('span', 'attachment-name', `${a.kind === 'screenshot' ? '🖼' : '📎'} ${a.name}`));
    const remove = button(
      '✕',
      () => {
        state.attachments.splice(index, 1);
        render();
      },
      'attachment-remove',
    );
    remove.title = t('ui.removeAttachment');
    chip.appendChild(remove);
    ui.composerFiles.appendChild(chip);
  });
  renderComposerPlaceholder();
}

function render() {
  renderMini();
  renderBadge();
  renderMood();
  const speechVisible = renderSpeech();
  renderBubble(speechVisible);
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
  if (state.speech && !state.speech.sticky && state.speech.until <= now) dismissSpeech();
  if (state.panelOpen && state.tab === 'timer') PetTools.tick(now);
}

// ------------------------------------------------------------------ greetings (time of day, battery, coming back)

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

function isMorning(hour) {
  return hour >= 5 && hour < 11;
}

function isNight(hour) {
  return hour >= 23 || hour < 5;
}

function checkTimeOfDay() {
  const now = new Date();
  const night = isNight(now.getHours());
  if (night !== state.mood.night) {
    state.mood.night = night;
    renderMood();
  }
  if (!state.config.greetings || state.modes.away || state.modes.dnd || state.config.mini) return;
  const day = now.toDateString();
  if (greet.morningDay == null) greet.morningDay = storage('pet.morningDay');
  if (isMorning(now.getHours()) && greet.morningDay !== day) {
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

// ------------------------------------------------------------------ panel & chat

function openPanel(tab) {
  state.panelOpen = true;
  if (tab) state.tab = tab;
  render();
}

function closePanel() {
  state.panelOpen = false;
  state.expanded = null;
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

function newChat() {
  if (state.chat.busy) api.quickStop();
  state.chat = { messages: [], sessionId: null, cwd: state.chat.cwd, busy: false };
  openPanel('chat');
  openComposer();
}

/** Put text (a memo) into the quick chat composer, ready to edit and send. */
function sendToChat(text, cwd) {
  if (cwd && cwd !== (state.chat.cwd || state.config.quickChatCwd) && !state.chat.busy) {
    state.chat = { messages: [], sessionId: null, cwd, busy: false };
  }
  ui.composerInput.value = text;
  openPanel('chat');
  openComposer();
}

function addAttachments(paths, kind) {
  for (const p of paths) {
    if (!p || state.attachments.some((a) => a.path === p) || state.attachments.length >= 10) continue;
    state.attachments.push({ path: p, name: basename(p), kind });
  }
}

async function sendQuick() {
  const typed = ui.composerInput.value.trim();
  const attachments = state.attachments;
  if ((!typed && !attachments.length) || state.chat.busy) return;
  const shot = attachments.some((a) => a.kind === 'screenshot');
  const prompt = typed || (shot ? t('ui.defaultShotPrompt') : t('ui.defaultFilePrompt'));
  ui.composerInput.value = '';
  state.attachments = [];
  const chat = state.chat;
  chat.messages.push({ role: 'user', text: prompt, files: attachments.map((a) => a.name) });
  chat.messages.push({ role: 'assistant', text: '', pending: true });
  chat.busy = true;
  openPanel('chat');
  playStatus();
  const res = await api.quickSend(
    prompt,
    chat.cwd || state.config.quickChatCwd,
    chat.sessionId,
    attachments.map((a) => a.path),
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
    case 'tool':
      if (reply) reply.tool = ev.name;
      break;
    case 'result':
      if (reply) {
        if (!reply.text && ev.text) reply.text = ev.text;
        reply.error = ev.isError;
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

// ------------------------------------------------------------------ drag & drop: feed the pet

function setupDrop() {
  let depth = 0;
  const hasPayload = (e) =>
    [...(e.dataTransfer ? e.dataTransfer.types : [])].some((type) => type === 'Files' || type === 'text/plain');
  document.addEventListener('dragenter', (e) => {
    if (!hasPayload(e)) return;
    e.preventDefault();
    depth += 1;
    ui.stage.classList.add('drop-target');
    ui.mini.classList.add('drop-target');
  });
  document.addEventListener('dragover', (e) => {
    if (!hasPayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) {
      ui.stage.classList.remove('drop-target');
      ui.mini.classList.remove('drop-target');
    }
  });
  document.addEventListener('drop', (e) => {
    depth = 0;
    ui.stage.classList.remove('drop-target');
    ui.mini.classList.remove('drop-target');
    const hasFiles = Boolean(e.dataTransfer.files && e.dataTransfer.files.length);
    // Text dropped into a text field is just typed there.
    if (!hasFiles && (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
    const text = files.length ? '' : (e.dataTransfer.getData('text/plain') || '').trim();
    if (!files.length && !text) return;
    if (files.length) addAttachments(files, 'file');
    if (text) ui.composerInput.value = ui.composerInput.value ? `${ui.composerInput.value}\n\n${text}` : text;
    if (!state.config.mini) playOnce('jumping', 1);
    say(t('say.fed'), { duration: 3000 });
    openPanel('chat');
    openComposer();
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
    if (state.speech && state.speech.sticky) {
      dismissSpeech();
      return;
    }
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
  ui.bubble.addEventListener('click', () => openPanel('sessions'));
  ui.speech.addEventListener('click', dismissSpeech);
  for (const node of [ui.bubble, ui.speech]) {
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api.contextMenu();
    });
  }
  ui.bubblePause.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = state.aggregate.primary;
    if (s) api.pauseSession(s.id);
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
      target.textContent = t('ui.saved');
      setTimeout(() => applyI18n(), 1200);
    }
  });
  $('chat-terminal').addEventListener('click', async () => {
    if (state.chat.sessionId) await api.openTerminal(state.chat.sessionId, state.chat.cwd);
  });

  ui.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendQuick();
  });
  ui.composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendQuick();
    }
  });
  ui.composerInput.addEventListener('input', reportSize);
  ui.composerCwd.addEventListener('click', async () => {
    const folder = await api.chooseFolder(state.chat.cwd || state.config.quickChatCwd);
    if (folder) {
      if (folder !== state.chat.cwd) state.chat.sessionId = null; // a new folder starts a new session
      state.chat.cwd = folder;
      render();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.speech && state.speech.sticky) dismissSpeech();
    else if (state.composerOpen) closeComposer();
    else if (state.panelOpen) closePanel();
  });

  setInterval(tick, 1000);
  setInterval(() => {
    if (state.panelOpen && state.tab === 'sessions') renderSessions();
  }, 30000);
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
  if (scaleChanged && state.pet) sprite.setPet(state.pet, config.scale);
  render();
}

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
  applyState(init.state);
  setupControls();

  api.on('state', applyState);
  api.on('config', applyConfig);
  api.on('pet', (pet) => {
    state.pet = pet;
    sprite.setPet(pet, state.config.scale);
    playOnce('waving', 2);
    render();
  });
  api.on('transition', ({ to, session, held: isHeld }) => {
    if (to === 'ready' && session.source !== 'quickchat' && !isHeld) playOnce('jumping', 2);
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
  api.on('attach', ({ files, kind }) => {
    addAttachments(files || [], kind === 'screenshot' ? 'screenshot' : 'file');
    openPanel('chat');
    openComposer();
  });

  playOnce('waving', 2);
  checkTimeOfDay();
  watchBattery();
}

boot();
