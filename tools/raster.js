'use strict';

// A tiny pixel canvas for drawing pet sprites in code. Every shape is filled
// with hard edges so the result reads as pixel art after nearest-neighbour scaling.

function parseColor(color) {
  if (Array.isArray(color)) return [color[0], color[1], color[2], color[3] ?? 255];
  if (typeof color !== 'string' || color[0] !== '#') throw new Error(`Unsupported color: ${color}`);
  const hex = color.slice(1);
  const full = hex.length === 3 || hex.length === 4 ? [...hex].map((ch) => ch + ch).join('') : hex;
  const value = parseInt(full, 16);
  if (full.length === 6) return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
  if (full.length === 8) return [(value >>> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255];
  throw new Error(`Unsupported color: ${color}`);
}

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x, y) {
    if (!this.inside(x, y)) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  alpha(x, y) {
    return this.inside(x, y) ? this.data[(y * this.width + x) * 4 + 3] : 0;
  }

  set(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (!this.inside(x, y)) return;
    const [r, g, b, a] = parseColor(color);
    const i = (y * this.width + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  clear(x, y) {
    this.set(x, y, [0, 0, 0, 0]);
  }

  /** Set several pixels given as [[x, y], ...] relative to (ox, oy). */
  pixels(ox, oy, points, color) {
    for (const [x, y] of points) this.set(ox + x, oy + y, color);
  }

  rect(x, y, w, h, color) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, color);
  }

  /** Filled ellipse sampled at pixel centres. `where(x, y)` can restrict the fill. */
  ellipse(cx, cy, rx, ry, color, where) {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1 && (!where || where(x, y))) this.set(x, y, color);
      }
    }
  }

  line(x0, y0, x1, y1, color) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** Recolour every opaque pixel matching `where(x, y)`. */
  recolor(color, where) {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.alpha(x, y) > 0 && where(x, y)) this.set(x, y, color);
      }
    }
  }

  /** Draw a 1px outline around the silhouette (4-neighbourhood). */
  outline(color) {
    const add = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.alpha(x, y) > 0) continue;
        if (this.alpha(x - 1, y) || this.alpha(x + 1, y) || this.alpha(x, y - 1) || this.alpha(x, y + 1)) add.push([x, y]);
      }
    }
    for (const [x, y] of add) this.set(x, y, color);
  }

  /**
   * Coloured ("sel-out") outline: each edge pixel takes the colour of the
   * pixel it outlines, darkened. Reads softer than a single black line.
   */
  outlineSelective(darken = 0.5) {
    const add = [];
    const n = [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1],
    ];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.alpha(x, y) > 0) continue;
        const hit = n.find(([dx, dy]) => this.alpha(x + dx, y + dy) > 0);
        if (!hit) continue;
        const [r, g, b] = this.get(x + hit[0], y + hit[1]);
        add.push([x, y, [r, g, b].map((v) => Math.round(v * (1 - darken)))]);
      }
    }
    for (const [x, y, c] of add) this.set(x, y, c);
  }

  /** Filled polygon (pixel-centre sampling, even-odd rule). `where(x, y)` can restrict the fill. */
  polygon(points, color, where) {
    const ys = points.map((p) => p[1]);
    const y0 = Math.floor(Math.min(...ys));
    const y1 = Math.ceil(Math.max(...ys));
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        if (ay <= sy !== by <= sy) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i] - 0.5); x <= Math.floor(xs[i + 1] - 0.5); x++) {
          if (!where || where(x, y)) this.set(x, y, color);
        }
      }
    }
  }

  /** A transparent canvas of the same size, for drawing a part on its own layer. */
  layer() {
    return new Canvas(this.width, this.height);
  }

  flipX() {
    const out = new Canvas(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const src = (y * this.width + x) * 4;
        const dst = (y * this.width + (this.width - 1 - x)) * 4;
        out.data.set(this.data.subarray(src, src + 4), dst);
      }
    }
    return out;
  }

  scale(factor) {
    const out = new Canvas(this.width * factor, this.height * factor);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const src = (Math.floor(y / factor) * this.width + Math.floor(x / factor)) * 4;
        out.data.set(this.data.subarray(src, src + 4), (y * out.width + x) * 4);
      }
    }
    return out;
  }

  /** Alpha-composite `src` onto this canvas at (dx, dy). */
  draw(src, dx, dy) {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const tx = dx + x;
        const ty = dy + y;
        if (!this.inside(tx, ty)) continue;
        const s = (y * src.width + x) * 4;
        const sa = src.data[s + 3] / 255;
        if (sa === 0) continue;
        const d = (ty * this.width + tx) * 4;
        const da = this.data[d + 3] / 255;
        const oa = sa + da * (1 - sa);
        for (let k = 0; k < 3; k++) {
          this.data[d + k] = Math.round((src.data[s + k] * sa + this.data[d + k] * da * (1 - sa)) / oa);
        }
        this.data[d + 3] = Math.round(oa * 255);
      }
    }
  }

  isEmpty() {
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i]) return false;
    return true;
  }
}

module.exports = { Canvas, parseColor };
