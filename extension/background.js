'use strict';

// Forwards what the claude.ai tabs report to the pet on this computer. The pet accepts
// events from extensions but nothing else, so this can't change any pet settings.

const PET_EVENT_URL = 'http://127.0.0.1:47717/event';

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'pet-event' || !msg.event) return;
  if (!sender.url || !sender.url.startsWith('https://claude.ai/')) return;
  fetch(PET_EVENT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...msg.event, ts: Date.now() }),
  }).catch(() => {
    // the pet isn't running
  });
});
