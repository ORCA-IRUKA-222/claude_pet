'use strict';

/* global PetI18n, PetSprite */

const api = window.pet;
const $ = (id) => document.getElementById(id);

const ui = {
  root: $('root'),
  panel: $('panel'),
  bubble: $('bubble'),
  bubbleTitle: $('bubble-title'),
  bubbleSub: $('bubble-sub'),
  stage: $('stage'),
  badge: $('badge'),
  mini: $('mini'),
  miniLabel: $('mini-label'),
  miniBadge: $('mini-badge'),
  sessionsCount: $('sessions-count'),
  sessionList: $('session-list'),
  sessionsEmpty: $('sessions-empty'),
  setupHint: $('setup-hint'),
  tabSessions: $('tab-sessions'),
  tabChat: $('tab-chat'),
  chatLog: $('chat-log'),
  chatStop: $('chat-stop'),
  composer: $('composer'),
  composerInput: $('composer-input'),
  composerCwd: $('composer-cwd'),
  composerTarget: $('composer-target'),
  composerSend: $('composer-send'),
};

const sprite = new PetSprite($('sprite'));

const state = {
  config: { scale: 0.5, mini: false, showBubble: true, language: 'ja', quickChatCwd: '', home: '' },
  pet: null,
  sessions: [],
  aggregate: { status: 'idle', activity: null, counts: {}, primary: null, total: 0 },
  hooksInstalled: true,
  panelOpen: false,
  tab: 'sessions',
  expanded: null,
  composerOpen: false,
  // target: local (Claude Code here), cloud (a cloud session: cloudId, url) or chat (a new chat in the app)
  chat: { messages: [], sessionId: null, cwd: '', busy: false, target: 'local', cloudId: null, url: null },
  cloning: false, // the composer asks for a GitHub repository instead of a message
  temporary: null, // a one-off animation (wave, jump) that overrides the status animation
  toast: null, // { title, sub } shown in the bubble for a few seconds, e.g. when the pet changes
};

let t = PetI18n.translator('ja');
const SOURCE_MARK = { quickchat: '💬 ', cloud: '☁ ', browser: '🌐 ' };
const AUTH_ERROR = /authenticat|oauth|\/login|api key/i;
let choosingFolder = false; // the folder dialog takes focus; keep the quick-chat box open

// ------------------------------------------------------------------ helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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
  if (s.activity) return t(`activity.${s.activity}`);
  return t(`status.${s.effectiveStatus}`);
}

function detailText(s) {
  switch (s.effectiveStatus) {
    case 'ready':
      return firstLine(s.message) || (s.backgroundTasks ? t('ui.backgroundTasks', { n: s.backgroundTasks }) : '');
    case 'failed':
      return s.detail || firstLine(s.message);
    case 'idle':
      return s.stale ? t('ui.stale') : firstLine(s.message) || firstLine(s.prompt);
    default:
      return s.detail || firstLine(s.prompt);
  }
}

function attentionCount() {
  const c = state.aggregate.counts || {};
  return (c.waiting || 0) + (c.failed || 0) + (c.ready || 0);
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
function showToast(title, sub, ms = 6000) {
  clearTimeout(toastTimer);
  state.toast = { title, sub };
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, ms);
}

// ------------------------------------------------------------------ rendering

function applyI18n() {
  document.documentElement.lang = state.config.language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
}

function renderBubble() {
  const agg = state.aggregate;
  const s = agg.primary;
  const visible = state.config.showBubble && !state.config.mini && !state.panelOpen;
  // Session news wins over the greeting toast.
  if (visible && state.toast && agg.status === 'idle') {
    ui.bubble.hidden = false;
    ui.bubble.className = 'bubble status-idle toast';
    ui.bubbleTitle.textContent = state.toast.title;
    ui.bubbleSub.replaceChildren(document.createTextNode(state.toast.sub));
    ui.bubbleSub.hidden = false;
    return;
  }
  const show = visible && s && agg.status !== 'idle';
  ui.bubble.hidden = !show;
  if (!show) return;
  ui.bubble.className = `bubble status-${agg.status}`;
  const others = attentionCount() + (agg.counts.running || 0) - 1;
  ui.bubbleTitle.textContent = `${sessionName(s)} · ${activityText(s)}`;
  const detail = detailText(s);
  ui.bubbleSub.replaceChildren(document.createTextNode(detail));
  if (others > 0) ui.bubbleSub.appendChild(el('span', 'bubble-more', t('bubble.more', { n: others })));
  ui.bubbleSub.hidden = !ui.bubbleSub.textContent;
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
  if (s.unread || s.effectiveStatus === 'failed') add(t('ui.markRead'), () => api.markRead(s.id));
  // cloud sessions and browser chats live on claude.ai, not on this computer
  if (s.url) add(t('ui.openInBrowser'), () => api.openUrl(s.url));
  else {
    if (s.effectiveStatus !== 'running' && s.effectiveStatus !== 'waiting') add(t('ui.continueHere'), () => continueInChat(s.id));
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
    row.title = s.project ? `${sessionName(s)}\n${s.project}` : sessionName(s);
    row.appendChild(main);
    row.addEventListener('click', () => {
      state.expanded = expanded ? null : s.id;
      if (!expanded && s.effectiveStatus === 'ready') api.markRead(s.id);
      renderPanel();
    });
    item.appendChild(row);

    if (expanded) {
      const body = el('div', 'session-body');
      const detail = detailText(s);
      body.appendChild(el('div', 'session-detail', detail ? `${activityText(s)} — ${detail}` : activityText(s)));
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
        box.appendChild(document.createTextNode(reply));
        body.appendChild(box);
      }
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
    const text = el('span', 'text', m.text);
    text.dataset.placeholder = t('ui.waitingAnswer');
    bubble.appendChild(text);
    if (m.pending && m.tool) bubble.appendChild(el('span', 'tool', `${state.chat.target === 'cloud' ? '☁' : '🔧'} ${m.tool}`));
    log.appendChild(bubble);
  }
  if (!state.chat.messages.length) log.appendChild(el('p', 'empty', placeholder(state.chat.target)));
  log.scrollTop = log.scrollHeight;
  ui.chatStop.hidden = !state.chat.busy;
  $('chat-terminal').disabled = state.chat.busy;
  $('chat-app').disabled = !(state.chat.sessionId || state.chat.url) || state.chat.busy;
  $('chat-app').title = t('ui.openInApp');
  $('chat-terminal').title = t('ui.openTerminal');
  $('chat-copy').disabled = !state.chat.messages.some((m) => m.role === 'assistant' && m.text);
}

function renderPanel() {
  ui.panel.hidden = !state.panelOpen;
  if (!state.panelOpen) return;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === state.tab);
  ui.tabSessions.hidden = state.tab !== 'sessions';
  ui.tabChat.hidden = state.tab !== 'chat';
  if (state.tab === 'sessions') renderSessions();
  else renderChat();
}

/** What the input says, including which model answers. */
function placeholder(target) {
  const { quickChatModel: model = '', quickChatEffort: effort = 'xhigh' } = state.config;
  return t(`ui.placeholder.${target}`, { model, effort: t(`effort.${effort}`) });
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
  ui.composerInput.placeholder = state.cloning ? t('ui.clonePlaceholder') : placeholder(target);
  ui.composerSend.disabled = state.chat.busy;
}

function render() {
  renderMini();
  renderBadge();
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
  if (state.chat.sessionId !== id) {
    if (state.chat.busy) return showToast(t('ui.chatBusy'));
    const res = await api.openChat(id);
    if (!res.ok) return showToast(t('ui.chatNotFound'), res.error);
    state.chat = {
      messages: res.messages,
      sessionId: id,
      cwd: res.cwd || state.chat.cwd,
      busy: false,
      target: 'local',
      cloudId: null,
      url: null,
    };
  }
  openPanel('chat');
  openComposer();
}

async function openInApp(id, cwd) {
  const res = await api.openDesktop(id, cwd);
  if (!res.ok) showToast(t('ui.appFailed'), res.error);
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
}

async function chooseWhere() {
  choosingFolder = true;
  const current = state.chat.cwd || state.config.quickChatCwd;
  const pick = await api.folderMenu(current).finally(() => (choosingFolder = false));
  let folder = pick && pick.dir;
  if (pick && pick.choose) {
    choosingFolder = true;
    folder = await api.chooseFolder(current).finally(() => (choosingFolder = false));
  }
  if (pick && pick.clone) {
    state.cloning = true;
    ui.composerInput.value = '';
    render();
    ui.composerInput.focus();
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
  const prompt = ui.composerInput.value.trim();
  if (!prompt || state.chat.busy) return;
  ui.composerInput.value = '';
  const chat = state.chat;
  chat.messages.push({ role: 'user', text: prompt });
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
  const res = await api.quickSend(prompt, chat.cwd || state.config.quickChatCwd, cloud ? chat.cloudId : chat.sessionId, cloud);
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
  ui.bubble.addEventListener('click', () => openPanel('sessions'));
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
  $('chat-app').addEventListener('click', () => {
    if (state.chat.url)
      api.openUrl(state.chat.url); // a cloud task opens on claude.ai/code
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendQuick();
    }
  });
  ui.composerInput.addEventListener('input', reportSize);
  // an empty quick-chat box goes away when you switch to another window
  window.addEventListener('blur', () => {
    if (state.composerOpen && !choosingFolder && !state.chat.busy && !ui.composerInput.value.trim()) closeComposer();
  });
  $('composer-close').addEventListener('click', closeComposer);
  ui.composerCwd.addEventListener('click', chooseWhere);
  ui.composerTarget.addEventListener('change', () => setTarget(ui.composerTarget.value));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.cloning) {
      state.cloning = false;
      ui.composerInput.value = '';
      render();
    } else if (state.composerOpen) closeComposer();
    else if (state.panelOpen) closePanel();
  });

  setInterval(() => {
    if (state.panelOpen && state.tab === 'sessions') renderSessions();
  }, 30000);
}

function applyState({ sessions, aggregate }) {
  state.sessions = sessions;
  state.aggregate = aggregate;
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

async function boot() {
  const init = await api.init();
  state.hooksInstalled = init.hooksInstalled;
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
  api.on('transition', ({ to, session }) => {
    if (to === 'ready' && session.source !== 'quickchat') playOnce('jumping', 2);
  });
  api.on('command', (cmd) => {
    if (cmd.type === 'panel') openPanel(cmd.tab);
    if (cmd.type === 'quickchat') {
      openPanel('chat');
      openComposer();
    }
  });
  api.on('quick-event', handleQuickEvent);
  playOnce('waving', 2);
}

boot();
