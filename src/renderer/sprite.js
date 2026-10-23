'use strict';

/* global PetAtlas */

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
    return Math.round(PetAtlas.CELL_WIDTH * this.scale);
  }

  get height() {
    return Math.round(PetAtlas.CELL_HEIGHT * this.scale);
  }

  setPet(pet, scale) {
    this.pet = pet;
    this.scale = scale;
    const el = this.el;
    el.replaceChildren();
    el.style.width = `${this.width}px`;
    el.style.height = `${this.height}px`;
    el.classList.toggle('pixel', Boolean(pet && pet.pixelArt));
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
   * @param {{loops?: number, onDone?: Function}} options finite loops call onDone afterwards
   */
  play(state, { loops = Infinity, onDone = null } = {}) {
    const row = PetAtlas.ROW_INDEX[state] || PetAtlas.ROW_INDEX.idle;
    if (this.state === row.state && loops === Infinity && this.pending && this.pending.loops === Infinity) return;
    clearTimeout(this.timer);
    this.state = row.state;
    this.pending = { loops, onDone };
    if (!this.pet) return;

    if (this.pet.kind !== 'atlas') {
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
