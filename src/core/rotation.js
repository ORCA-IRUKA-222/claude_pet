'use strict';

// Pet rotation: switch to another pet every N minutes. Picks come from a
// shuffled "bag", so every pet appears once before any pet repeats.

const ORDERS = new Set(['shuffle', 'sequence']);

/** Keys of the pets that take part in the rotation. */
function candidates(pets, rotation = {}) {
  let list = pets;
  if (Array.isArray(rotation.pets) && rotation.pets.length) {
    list = pets.filter((p) => rotation.pets.includes(p.key) || rotation.pets.includes(p.id));
  } else if (rotation.group) {
    list = pets.filter((p) => p.group === rotation.group);
  }
  return list.map((p) => p.key);
}

function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Choose the next pet.
 * @returns {{ next: string|null, queue: string[] }} next is null when there is nothing to switch to
 */
function pickNext(keys, current, { order = 'shuffle', queue = [], random = Math.random } = {}) {
  const others = keys.filter((k) => k !== current);
  if (!others.length) return { next: keys.includes(current) ? null : keys[0] || null, queue: [] };

  if (order === 'sequence') {
    const sorted = [...keys].sort();
    const index = sorted.indexOf(current);
    return { next: sorted[(index + 1) % sorted.length], queue: [] };
  }

  let bag = (queue || []).filter((k) => others.includes(k));
  if (!bag.length) bag = shuffle(others, random);
  const [next, ...rest] = bag;
  return { next, queue: rest };
}

function intervalMs(rotation) {
  const minutes = Number(rotation.intervalMinutes);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60e3;
}

/** True when the rotation is on and the current pet has been shown long enough. */
function isDue(rotation, now = Date.now()) {
  return Boolean(rotation && rotation.enabled) && now - (Number(rotation.lastChangedAt) || 0) >= intervalMs(rotation);
}

/** Groups declared by installed pets (pet.json "group"), for menus. */
function groups(pets) {
  return [...new Set(pets.map((p) => p.group).filter(Boolean))].sort();
}

function normalizeOrder(order) {
  return ORDERS.has(order) ? order : 'shuffle';
}

module.exports = { candidates, pickNext, isDue, intervalMs, groups, normalizeOrder };
