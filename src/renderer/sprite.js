'use strict';

/* global PetAtlas */

// Image pets may give a picture per animation row or per pet status.
const STATUS_OF_ROW = {
  idle: 'idle',
  running: 'running',
  review: 'running',
  waiting: 'waiting',
  failed: 'failed',
  jumping: 'ready',
  waving: 'ready',
};

// Plays one animation row at a time. Atlas pets step through spritesheet
// frames using the Codex frame timings; image pets swap a CSS animation class.
class PetSprite {
  constructor(el) {
    this.el = el;
    this.pet = null;
    this.scale = 0.5;
    this.state = null;
    this.timer = null;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  get width() {
    const pet = this.pet;
    if (pet && pet.kind === 'image' && pet.displayHeight) return Math.round((this.height * pet.width) / pet.height);
    return Math.round(PetAtlas.CELL_WIDTH * this.scale);
  }

  get height() {
    const pet = this.pet;
    if (pet && pet.kind === 'image' && pet.displayHeight) return Math.round(pet.displayHeight * this.scale);
    return Math.round(PetAtlas.CELL_HEIGHT * this.scale);
  }

  /** Picture for a row: row-specific first, then the pet status (e.g. "ready" while idling unread), then the row's status. */
  imageFor(row) {
    const states = (this.pet && this.pet.states) || {};
    const status = row === 'idle' ? this.status : null;
    return states[row] || (status && states[status]) || states[STATUS_OF_ROW[row]] || this.pet;
  }

  showImage(row) {
    const img = this.el.querySelector('img');
    const src = this.imageFor(row).url;
    if (img && img.getAttribute('src') !== src) img.src = src;
  }

  setPet(pet, scale) {
    this.pet = pet;
    this.scale = scale;
    const el = this.el;
    el.replaceChildren();
    el.style.width = `${this.width}px`;
    el.style.height = `${this.height}px`;
    el.classList.toggle('pixel', Boolean(pet && pet.pixelArt));
    el.classList.toggle('illust', Boolean(pet && pet.kind === 'image' && pet.displayHeight));
    el.style.backgroundImage = '';
    if (!pet) return;

    if (pet.kind === 'atlas') {
      const columns = pet.width / pet.cellWidth;
      el.style.backgroundImage = `url("${pet.url}")`;
      el.style.backgroundSize = `${columns * this.width}px ${pet.rows * this.height}px`;
    } else {
      const img = document.createElement('img');
      img.src = pet.url;
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
    }
    const state = this.state || 'idle';
    this.state = null;
    this.play(state, this.pending || {});
  }

  /**
   * Play an animation row.
   * @param {string} state row name (idle, running, waiting, ...)
   * @param {{loops?: number, onDone?: Function, status?: string}} options finite loops call onDone
   *   afterwards; `status` is the pet status, which image pets use to pick a picture
   */
  play(state, { loops = Infinity, onDone = null, status } = {}) {
    const row = PetAtlas.ROW_INDEX[state] || PetAtlas.ROW_INDEX.idle;
    if (status !== undefined) this.status = status;
    if (this.state === row.state && loops === Infinity && this.pending && this.pending.loops === Infinity) {
      if (this.pet && this.pet.kind !== 'atlas') this.showImage(row.state);
      return;
    }
    clearTimeout(this.timer);
    this.state = row.state;
    this.pending = { loops, onDone };
    if (!this.pet) return;

    if (this.pet.kind !== 'atlas') {
      this.showImage(row.state);
      this.el.className = this.el.className.replace(/\banim-[\w-]+/g, '').trim();
      if (!this.reducedMotion) this.el.classList.add(`anim-${row.state}`);
      if (loops !== Infinity) {
        const total = row.durations.reduce((a, b) => a + b, 0) * loops;
        this.timer = setTimeout(() => this.finish(), total);
      }
      return;
    }

    let frame = 0;
    let loop = 0;
    const tick = () => {
      this.showFrame(row.index, frame);
      if (this.reducedMotion) {
        if (loops !== Infinity) this.timer = setTimeout(() => this.finish(), 600);
        return;
      }
      const delay = row.durations[frame];
      frame += 1;
      if (frame >= row.frames) {
        frame = 0;
        loop += 1;
        if (loop >= loops) {
          this.timer = setTimeout(() => this.finish(), delay);
          return;
        }
      }
      this.timer = setTimeout(tick, delay);
    };
    tick();
  }

  finish() {
    const done = this.pending && this.pending.onDone;
    this.pending = { loops: Infinity, onDone: null };
    if (done) done();
  }

  showFrame(rowIndex, frame) {
    this.el.style.backgroundPosition = `${-frame * this.width}px ${-rowIndex * this.height}px`;
  }
}

window.PetSprite = PetSprite;
