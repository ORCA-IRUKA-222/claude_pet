'use strict';

// Watches a claude.ai tab and tells the pet when Claude starts and finishes a reply. It only
// reads the page; it never clicks or types anything.

(() => {
  const POLL_MS = 1000;
  let last = { streaming: false, chat: null };

  const chatId = () => (location.pathname.match(/\/chat\/([0-9a-f-]{36})/) || [])[1] || null;

  function streaming() {
    // the reply being written carries data-is-streaming="true", and the send button turns into a stop button
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    return Boolean(document.querySelector('button[aria-label*="Stop" i], button[aria-label*="停止"]'));
  }

  function lastText(selectors) {
    for (const selector of selectors) {
      const all = document.querySelectorAll(selector);
      if (all.length) return all[all.length - 1].innerText.trim();
    }
    return '';
  }

  const title = () => document.title.replace(/\s*[-–|]\s*Claude\s*$/, '').trim() || 'claude.ai';

  function send(event) {
    try {
      chrome.runtime.sendMessage({ type: 'pet-event', event }).catch(() => {});
    } catch {
      // the extension was reloaded; this tab's script is orphaned
    }
  }

  function tick() {
    const chat = chatId();
    const now = Boolean(chat) && streaming();
    const base = (id) => ({ session_id: `claude-ai-${id}`, title: title(), url: `https://claude.ai/chat/${id}` });
    if (last.streaming && (!now || last.chat !== chat)) {
      // finished (or the tab moved to another chat)
      send({
        event: 'Stop',
        ...base(last.chat),
        message: last.chat === chat ? lastText(['[data-is-streaming]', '.font-claude-response']).slice(0, 4000) : null,
      });
    }
    if (now && (!last.streaming || last.chat !== chat)) {
      send({ event: 'UserPromptSubmit', ...base(chat), prompt: lastText(['[data-testid="user-message"]']).slice(0, 300) });
    }
    last = { streaming: now, chat };
  }

  setInterval(tick, POLL_MS);
})();
