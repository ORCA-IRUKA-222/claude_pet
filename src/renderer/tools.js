'use strict';

/* global PetTime */

// The panel tabs that aren't about Claude: タイマー (timer, pomodoro, stopwatch),
// メモ and 予定 (calendar). State lives in the main process; these views draw
// snapshots of it and send commands back.
const PetTools = (() => {
  let ctx = null; // { api, t, language, sendToChat, copy, rerender }
  const data = { timers: null, memos: [], calendar: null };
  const view = {
    timer: 'timer', // 'timer' | 'pomodoro' | 'stopwatch'
    timerError: '',
    timerInput: '',
    memoFilter: 'all',
    memoExpanded: null,
    memoEditing: null,
    memoDraft: '', // what is typed in the new-memo box
    memoEditText: null, // what is typed while editing memoEditing
    calSetup: false,
    calInput: '',
    calError: '',
  };
  // what you type isn't part of a view's shape: the boxes already show it
  const TYPED = new Set(['timerInput', 'memoDraft', 'memoEditText', 'calInput']);
  const DRAFT_KEY = 'claude-pet.memo-draft';
  let lastRender = null; // what the tool tab last drew, to skip redrawing the same thing
  let composing = false; // an IME is composing in one of the boxes
  let redrawAfterIme = false;

  /** Memo drafts survive a reload or restart of the pet (they live only on this computer). */
  function saveDrafts() {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ draft: view.memoDraft, editing: view.memoEditing, editText: view.memoEditText }),
      );
    } catch {
      // no storage: the draft still survives redraws
    }
  }

  function loadDrafts() {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!saved) return;
      if (typeof saved.draft === 'string') view.memoDraft = saved.draft;
      if (typeof saved.editing === 'string' && typeof saved.editText === 'string') {
        view.memoEditing = saved.editing;
        view.memoEditText = saved.editText;
      }
    } catch {
      // unreadable: start empty
    }
  }

  const PRESETS = [1, 3, 5, 10, 25];

  function t(key, vars) {
    return ctx.t()(key, vars);
  }

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

  function row(className, ...children) {
    const node = el('div', className);
    for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  async function timer(action, value) {
    const res = await ctx.api.timer(action, value);
    view.timerError = res && !res.ok ? res.error || '' : '';
  }

  // ---------------------------------------------------------------- timer tab

  function timerRemaining(now) {
    const tm = data.timers && data.timers.timer;
    if (!tm) return 0;
    return tm.endsAt ? Math.max(0, tm.endsAt - now) : tm.remaining;
  }

  function pomoRemaining(now) {
    const p = data.timers && data.timers.pomodoro;
    if (!p || !p.phase) return p ? p.settings.focusMinutes * 60e3 : 0;
    return p.endsAt ? Math.max(0, p.endsAt - now) : p.remaining;
  }

  function stopwatchElapsed(now) {
    const sw = data.timers && data.timers.stopwatch;
    if (!sw) return 0;
    return sw.elapsed + (sw.startedAt ? now - sw.startedAt : 0);
  }

  function countdown(ms) {
    return PetTime.formatClock(Math.ceil(ms / 1000) * 1000);
  }

  function progressBar(id) {
    const bar = el('div', 'progress');
    const fill = el('div', 'progress-fill');
    fill.id = id;
    bar.appendChild(fill);
    return bar;
  }

  function renderTimerPane(body) {
    const tm = data.timers.timer;
    const running = Boolean(tm.endsAt);
    const paused = !running && tm.remaining > 0;
    const clock = el('div', 'big-clock', countdown(running || paused ? timerRemaining(Date.now()) : 0));
    clock.id = 'tt-timer-clock';
    if (running) clock.classList.add('running');
    body.appendChild(clock);
    if ((running || paused) && tm.label) body.appendChild(el('div', 'clock-label', tm.label));
    if (running || paused) body.appendChild(progressBar('tt-timer-bar'));

    if (running || paused) {
      body.appendChild(
        row(
          'tool-actions',
          running
            ? button(t('timer.pause'), () => timer('pause'))
            : button(t('timer.resume'), () => timer('resume'), 'pill-button primary'),
          button(t('timer.reset'), () => timer('reset')),
        ),
      );
    } else {
      body.appendChild(
        row(
          'presets',
          ...PRESETS.map((m) =>
            button(PetTime.formatSpan(m * 60e3, ctx.language()), () => timer('start', { ms: m * 60e3 }), 'pill-button'),
          ),
        ),
      );
    }

    const form = el('form', 'tool-form');
    const input = el('input', 'tool-input');
    input.dataset.field = 'timer-custom';
    input.type = 'text';
    input.placeholder = t('timer.custom');
    input.value = view.timerInput;
    input.addEventListener('input', () => (view.timerInput = input.value));
    form.appendChild(input);
    const start = el('button', 'pill-button primary', t('timer.start'));
    start.type = 'submit';
    form.appendChild(start);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ms = PetTime.parseDuration(input.value);
      if (!ms) {
        view.timerError = t('timer.invalid');
        ctx.rerender();
        return;
      }
      view.timerInput = '';
      timer('start', { ms });
    });
    body.appendChild(form);
  }

  function renderPomodoroPane(body) {
    const p = data.timers.pomodoro;
    const running = Boolean(p.endsAt);
    const active = Boolean(p.phase);
    const phase = el('div', `pomo-phase phase-${p.phase || 'idle'}`);
    phase.appendChild(el('span', 'pomo-name', active ? t(`pomo.${p.phase}`) : '🍅'));
    if (p.round) phase.appendChild(el('span', 'pomo-round', t('pomo.round', { n: p.round })));
    body.appendChild(phase);

    const clock = el('div', 'big-clock', countdown(pomoRemaining(Date.now())));
    clock.id = 'tt-pomo-clock';
    if (running) clock.classList.add('running');
    body.appendChild(clock);
    if (active) body.appendChild(progressBar('tt-pomo-bar'));

    const actions = row('tool-actions');
    if (!active) actions.appendChild(button(t('timer.start'), () => timer('pomo-start'), 'pill-button primary'));
    else {
      actions.appendChild(
        running
          ? button(t('timer.pause'), () => timer('pomo-pause'))
          : button(t('timer.resume'), () => timer('pomo-start'), 'pill-button primary'),
      );
      actions.appendChild(button(t('timer.skip'), () => timer('pomo-skip')));
      actions.appendChild(button(t('timer.stop'), () => timer('pomo-stop')));
    }
    body.appendChild(actions);
    const s = p.settings;
    body.appendChild(
      el(
        'p',
        'tool-note',
        t('pomo.settings', { focus: s.focusMinutes, break: s.breakMinutes, long: s.longBreakMinutes, every: s.longBreakEvery }),
      ),
    );
    body.appendChild(el('p', 'tool-note', t('pomo.hint')));
  }

  function renderStopwatchPane(body) {
    const sw = data.timers.stopwatch;
    const clock = el('div', 'big-clock', PetTime.formatClock(stopwatchElapsed(Date.now())));
    clock.id = 'tt-sw-clock';
    if (sw.startedAt) clock.classList.add('running');
    body.appendChild(clock);
    body.appendChild(
      row(
        'tool-actions',
        sw.startedAt
          ? button(t('timer.pause'), () => timer('sw-pause'))
          : button(sw.elapsed ? t('timer.resume') : t('timer.start'), () => timer('sw-start'), 'pill-button primary'),
        sw.elapsed || sw.startedAt ? button(t('timer.reset'), () => timer('sw-reset')) : null,
      ),
    );
  }

  function renderTimerTab(container) {
    if (!data.timers) return;
    const segments = row('segments');
    for (const key of ['timer', 'pomodoro', 'stopwatch']) {
      const b = button(
        t(`timer.${key}`),
        () => {
          view.timer = key;
          view.timerError = '';
          ctx.rerender();
        },
        `segment${view.timer === key ? ' active' : ''}`,
      );
      if (key === 'timer' && data.timers.timer.endsAt) b.appendChild(el('span', 'segment-dot'));
      if (key === 'pomodoro' && data.timers.pomodoro.endsAt) b.appendChild(el('span', 'segment-dot'));
      if (key === 'stopwatch' && data.timers.stopwatch.startedAt) b.appendChild(el('span', 'segment-dot'));
      segments.appendChild(b);
    }
    container.appendChild(segments);
    const body = el('div', 'tool-body');
    if (view.timer === 'pomodoro') renderPomodoroPane(body);
    else if (view.timer === 'stopwatch') renderStopwatchPane(body);
    else renderTimerPane(body);
    if (view.timerError) body.appendChild(el('p', 'tool-error', view.timerError));
    container.appendChild(body);
    tick(Date.now());
  }

  function setBar(id, fraction) {
    const node = document.getElementById(id);
    if (node) node.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  function setText(id, text) {
    const node = document.getElementById(id);
    if (node && node.textContent !== text) node.textContent = text;
  }

  /** Called every second while the timer tab is open. */
  function tick(now) {
    if (!data.timers) return;
    const tm = data.timers.timer;
    if (tm.endsAt || tm.remaining) {
      const left = timerRemaining(now);
      setText('tt-timer-clock', countdown(left));
      setBar('tt-timer-bar', tm.duration ? 1 - left / tm.duration : 0);
    }
    const p = data.timers.pomodoro;
    setText('tt-pomo-clock', countdown(pomoRemaining(now)));
    if (p.phase) setBar('tt-pomo-bar', p.duration ? 1 - pomoRemaining(now) / p.duration : 0);
    setText('tt-sw-clock', PetTime.formatClock(stopwatchElapsed(now)));
  }

  // ---------------------------------------------------------------- memo tab

  async function memo(request) {
    const res = await ctx.api.memo(request);
    return res && res.ok;
  }

  function memoTime(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString(ctx.locale(), { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(ctx.locale(), { month: 'numeric', day: 'numeric' });
  }

  function renderMemoItem(m) {
    const item = el('li', `memo${m.done ? ' done' : ''}${view.memoExpanded === m.id ? ' expanded' : ''}`);
    const check = button(m.done ? '✓' : '', () => memo({ action: 'update', id: m.id, changes: { done: !m.done } }), 'memo-check');
    check.setAttribute('aria-label', m.done ? 'undo' : 'done');
    item.appendChild(check);

    const main = el('div', 'memo-main');
    if (view.memoEditing === m.id) {
      const area = el('textarea', 'memo-edit');
      area.dataset.field = 'memo-edit';
      area.value = view.memoEditText ?? m.text;
      area.rows = 3;
      area.addEventListener('keydown', (e) => e.stopPropagation());
      area.addEventListener('input', () => {
        view.memoEditText = area.value;
        saveDrafts();
      });
      main.appendChild(area);
      const stopEditing = () => {
        view.memoEditing = null;
        view.memoEditText = null;
        saveDrafts();
      };
      main.appendChild(
        row(
          'memo-actions',
          button(t('memo.save'), async () => {
            if (await memo({ action: 'update', id: m.id, changes: { text: area.value } })) stopEditing();
            ctx.rerender();
          }),
          button(t('memo.cancel'), () => {
            stopEditing();
            ctx.rerender();
          }),
        ),
      );
      if (view.memoEditText == null) requestAnimationFrame(() => area.focus());
    } else {
      const text = el('div', 'memo-text', m.text);
      text.addEventListener('click', () => {
        view.memoExpanded = view.memoExpanded === m.id ? null : m.id;
        ctx.rerender();
      });
      main.appendChild(text);
      const meta = el('div', 'memo-meta');
      if (m.project) meta.appendChild(el('span', 'chip', m.project));
      meta.appendChild(el('span', null, memoTime(m.createdAt)));
      main.appendChild(meta);
      if (view.memoExpanded === m.id) {
        main.appendChild(
          row(
            'memo-actions',
            button(t('memo.send'), () => ctx.sendToChat(m.text, m.cwd)),
            button(t('memo.copy'), (b) => {
              ctx.copy(m.text);
              b.textContent = t('ui.copied');
            }),
            button(t('memo.edit'), () => {
              view.memoEditing = m.id;
              view.memoEditText = null;
              ctx.rerender();
            }),
            button(t('memo.delete'), () => memo({ action: 'remove', id: m.id }), 'text-button danger'),
          ),
        );
      }
    }
    item.appendChild(main);
    return item;
  }

  function renderMemoTab(container) {
    const form = el('form', 'memo-form');
    const input = el('textarea', 'memo-input');
    input.dataset.field = 'memo-new';
    input.rows = 2;
    input.placeholder = t('memo.placeholder');
    input.value = view.memoDraft;
    input.addEventListener('input', () => {
      view.memoDraft = input.value;
      saveDrafts();
      ctx.reportSize();
    });
    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      // cleared first: the saved list can arrive (and redraw the box) before the reply
      view.memoDraft = '';
      input.value = '';
      saveDrafts();
      if (!(await memo({ action: 'add', text }))) {
        view.memoDraft = text;
        saveDrafts();
        ctx.rerender();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    form.appendChild(input);
    const add = el('button', 'pill-button primary', t('memo.add'));
    add.type = 'submit';
    form.appendChild(add);
    container.appendChild(form);

    const memos = data.memos || [];
    const toolbar = row('toolbar');
    for (const key of ['all', 'open']) {
      toolbar.appendChild(
        button(
          t(key === 'all' ? 'memo.filterAll' : 'memo.filterOpen'),
          () => {
            view.memoFilter = key;
            ctx.rerender();
          },
          `chip-button${view.memoFilter === key ? ' active' : ''}`,
        ),
      );
    }
    toolbar.appendChild(el('span', 'spacer'));
    if (memos.some((m) => m.done)) toolbar.appendChild(button(t('memo.clearDone'), () => memo({ action: 'clear-done' })));
    container.appendChild(toolbar);

    const shown = view.memoFilter === 'open' ? memos.filter((m) => !m.done) : memos;
    if (!shown.length) {
      container.appendChild(el('p', 'empty', t('memo.empty')));
      return;
    }
    const list = el('ul', 'memo-list');
    for (const m of shown) list.appendChild(renderMemoItem(m));
    container.appendChild(list);
  }

  // ---------------------------------------------------------------- calendar tab

  function dayStart(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dayLabel(start) {
    const today = dayStart(Date.now());
    const date = new Date(start).toLocaleDateString(ctx.locale(), { month: 'numeric', day: 'numeric', weekday: 'short' });
    if (start === today) return `${t('cal.today')} · ${date}`;
    if (start === today + 86400e3) return `${t('cal.tomorrow')} · ${date}`;
    return date;
  }

  function hm(ms) {
    return new Date(ms).toLocaleTimeString(ctx.locale(), { hour: '2-digit', minute: '2-digit' });
  }

  function renderCalendarSetup(container, configured) {
    const box = el('div', 'cal-setup');
    box.appendChild(el('div', 'cal-title', t('cal.setupTitle')));
    box.appendChild(el('p', 'tool-note', t('cal.setupHelp')));
    const form = el('form', 'tool-form');
    const input = el('input', 'tool-input');
    input.dataset.field = 'cal-url';
    input.type = 'url';
    input.placeholder = t('cal.urlPlaceholder');
    input.spellcheck = false;
    input.value = view.calInput;
    input.addEventListener('input', () => (view.calInput = input.value));
    form.appendChild(input);
    const save = el('button', 'pill-button primary', t('cal.save'));
    save.type = 'submit';
    form.appendChild(save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = input.value.trim();
      if (!/^(https?|webcals?):\/\//i.test(url)) {
        view.calError = t('cal.invalidUrl');
        ctx.rerender();
        return;
      }
      save.disabled = true;
      const res = await ctx.api.calendarSetUrl(url);
      save.disabled = false;
      if (res && res.ok) {
        view.calSetup = false;
        view.calError = '';
        view.calInput = '';
        setCalendar(res.calendar);
      } else {
        view.calError = t('cal.invalidUrl');
      }
      ctx.rerender();
    });
    box.appendChild(form);
    if (view.calError) box.appendChild(el('p', 'tool-error', view.calError));
    box.appendChild(el('p', 'tool-note', t('cal.privacy')));
    if (configured) {
      box.appendChild(
        row(
          'tool-actions',
          button(t('memo.cancel'), () => {
            view.calSetup = false;
            ctx.rerender();
          }),
          button(
            t('cal.remove'),
            async () => {
              const res = await ctx.api.calendarSetUrl(null);
              if (res && res.ok) setCalendar(res.calendar);
              view.calSetup = false;
              ctx.rerender();
            },
            'text-button danger',
          ),
        ),
      );
    }
    container.appendChild(box);
  }

  function renderCalendarTab(container) {
    const cal = data.calendar || { configured: false, events: [] };
    if (!cal.configured || view.calSetup) {
      renderCalendarSetup(container, cal.configured);
      return;
    }
    const status = cal.loading
      ? t('cal.loading')
      : cal.error
        ? t('cal.error', { error: cal.error })
        : cal.updatedAt
          ? t('cal.updated', { time: hm(cal.updatedAt) })
          : '';
    const toolbar = row('toolbar');
    toolbar.appendChild(el('span', `cal-status${cal.error ? ' error' : ''}`, status));
    toolbar.appendChild(el('span', 'spacer'));
    toolbar.appendChild(button(t('cal.refresh'), () => ctx.api.calendarRefresh()));
    toolbar.appendChild(
      button(t('cal.change'), () => {
        view.calSetup = true;
        view.calError = '';
        ctx.rerender();
      }),
    );
    container.appendChild(toolbar);

    if (!cal.events.length) {
      container.appendChild(el('p', 'empty', cal.loading ? t('cal.loading') : t('cal.empty')));
      return;
    }
    const now = Date.now();
    const today = dayStart(now);
    const groups = new Map();
    for (const ev of cal.events) {
      const key = Math.max(dayStart(ev.start), today);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    }
    const list = el('div', 'cal-list');
    for (const [day, events] of groups) {
      list.appendChild(el('div', 'cal-day', dayLabel(day)));
      for (const ev of events) {
        const live = !ev.allDay && ev.start <= now && ev.end > now;
        const item = el('div', `cal-event${live ? ' now' : ''}${ev.allDay ? ' all-day' : ''}`);
        item.appendChild(el('span', 'cal-time', ev.allDay ? t('cal.allDay') : `${hm(ev.start)}–${hm(ev.end)}`));
        const main = el('div', 'cal-main');
        const title = el('div', 'cal-summary', ev.summary || t('cal.untitled'));
        if (live) title.appendChild(el('span', 'chip live', t('cal.now')));
        main.appendChild(title);
        if (ev.location) main.appendChild(el('div', 'cal-location', `📍 ${ev.location.split('\n')[0]}`));
        item.appendChild(main);
        list.appendChild(item);
      }
    }
    container.appendChild(list);
  }

  // ---------------------------------------------------------------- api

  function setTimers(snapshot) {
    data.timers = snapshot;
  }

  function setMemos(list) {
    data.memos = Array.isArray(list) ? list : [];
    if (view.memoExpanded && !data.memos.some((m) => m.id === view.memoExpanded)) view.memoExpanded = null;
  }

  function setCalendar(snapshot) {
    data.calendar = snapshot;
  }

  /** Everything a tab draws from, except what is typed into it. */
  function shapeOf(tab) {
    const shown = tab === 'timer' ? data.timers : tab === 'memo' ? data.memos : data.calendar;
    const shape = Object.fromEntries(Object.entries(view).filter(([k]) => !TYPED.has(k)));
    // the calendar's "now" moves with the clock, memo times with the day
    const clock = tab === 'calendar' ? Math.floor(Date.now() / 60e3) : new Date().toDateString();
    return JSON.stringify([tab, ctx.language(), shape, shown, clock]);
  }

  /**
   * Draw a tab. The panel redraws on every change in the pet (a hook event, a new pet, a
   * message), so a tab is only drawn again when something it shows changed, and a box you
   * are typing in keeps its text, focus and cursor; it waits while an IME is composing.
   */
  function render(tab, container) {
    const shape = shapeOf(tab);
    if (lastRender && lastRender.container === container && lastRender.shape === shape && container.firstChild) return;
    const active = document.activeElement;
    const typing = active && container.contains(active) && active.dataset.field ? active : null;
    if (typing && composing) {
      redrawAfterIme = true;
      return;
    }
    const caret = typing && { field: typing.dataset.field, start: typing.selectionStart, end: typing.selectionEnd };
    lastRender = { container, shape };
    container.replaceChildren();
    if (tab === 'timer') renderTimerTab(container);
    else if (tab === 'memo') renderMemoTab(container);
    else if (tab === 'calendar') renderCalendarTab(container);
    const again = caret && container.querySelector(`[data-field="${caret.field}"]`);
    if (again) {
      again.focus();
      try {
        again.setSelectionRange(caret.start, caret.end);
      } catch {
        // some input types have no cursor
      }
    }
  }

  /** Something is counting in the timer tab (shown as a dot on the tab). */
  function busy() {
    const tm = data.timers;
    return Boolean(tm && (tm.timer.endsAt || tm.pomodoro.endsAt || tm.stopwatch.startedAt));
  }

  function init(context) {
    ctx = context;
    loadDrafts();
    document.addEventListener('compositionstart', () => (composing = true), true);
    document.addEventListener(
      'compositionend',
      () => {
        composing = false;
        if (!redrawAfterIme) return;
        redrawAfterIme = false;
        // after the composed text is in the box (and in its draft)
        setTimeout(() => ctx.rerender(), 0);
      },
      true,
    );
  }

  return { init, render, tick, setTimers, setMemos, setCalendar, busy, data };
})();

window.PetTools = PetTools;
