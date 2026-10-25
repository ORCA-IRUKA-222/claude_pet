// What a pet says in each scene (finished, waiting, morning, …), picked at random.
// Usable from Node and from the renderer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetLines = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // scene → what can be filled in
  const SCENES = {
    ready: ['project'], // Claude finished
    waiting: ['project'], // a permission prompt or a question
    failed: ['project'], // stopped by an error
    morning: [], // first time you meet in the morning
    night: [], // late at night
    welcome: ['summary'], // back at the computer (summary: what happened meanwhile)
    timer: [], // a timer ran out
    focus: ['min'], // a pomodoro focus starts
    break: ['min'], // a pomodoro break starts
    click: [], // the pet was clicked
    arrive: [], // the pet took over (rotation)
  };
  const MAX_PER_SCENE = 50;
  const MAX_LENGTH = 200;
  const PLACEHOLDER = /\{(\w+)\}/g;

  /** Keep known scenes with their non-empty lines only. */
  function normalize(lines) {
    const out = {};
    if (!lines || typeof lines !== 'object') return out;
    for (const scene of Object.keys(SCENES)) {
      const raw = lines[scene];
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      const clean = list
        .filter((l) => typeof l === 'string')
        .map((l) => l.trim().slice(0, MAX_LENGTH))
        .filter(Boolean)
        .slice(0, MAX_PER_SCENE);
      if (clean.length) out[scene] = clean;
    }
    return out;
  }

  function needs(line) {
    return [...String(line).matchAll(PLACEHOLDER)].map((m) => m[1]);
  }

  function has(vars, key) {
    return vars[key] != null && vars[key] !== '';
  }

  function fill(line, vars) {
    return String(line).replace(PLACEHOLDER, (m, key) => (has(vars, key) ? String(vars[key]) : m));
  }

  const last = {}; // scene → the line said last time, so it doesn't come twice in a row

  /**
   * A line for a scene, or null when the pet has none that fits.
   * Lines whose {placeholders} can't be filled are skipped. With `want`, lines that use
   * those values (e.g. {summary}) are tried first, so the information isn't lost.
   * @returns {{ text: string, uses: string[] } | null}
   */
  function pick(lines, scene, vars = {}, { want = [], random = Math.random } = {}) {
    const list = (lines && lines[scene]) || [];
    const usable = list.filter((l) => needs(l).every((key) => has(vars, key)));
    if (!usable.length) return null;
    const wanted = want.filter((key) => has(vars, key));
    const specific = wanted.length ? usable.filter((l) => wanted.every((key) => needs(l).includes(key))) : [];
    let pool = specific.length ? specific : usable;
    if (pool.length > 1) pool = pool.filter((l) => l !== last[scene]);
    const line = pool[Math.floor(random() * pool.length)];
    last[scene] = line;
    return { text: fill(line, vars), uses: needs(line) };
  }

  return { SCENES, normalize, pick, fill, needs };
});
