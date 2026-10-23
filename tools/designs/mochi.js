'use strict';

// Mochi: the built-in pet. A soft rice-cake creature with a terracotta sprout.
// Build with: node tools/build-pet.js tools/designs/mochi.js --out pets/mochi

const C = {
  outline: '#4a3226',
  body: '#fff6ea',
  shade: '#f0d9c3',
  light: '#ffffff',
  eye: '#3a2a22',
  cheek: '#f6a6a0',
  mouth: '#7a4a3a',
  sprout: '#d97757',
  sproutDark: '#b65a3c',
  tear: '#8fd3ff',
  sweat: '#bfe8ff',
};

const GROUND = 48; // y of the bottom row of the feet

function drawEyes(c, x, y, kind, look) {
  const eyes = [x - 5 + look, x + 4 + look];
  for (const ex of eyes) {
    switch (kind) {
      case 'closed':
        c.rect(ex - 1, y + 1, 3, 1, C.eye);
        break;
      case 'happy':
        c.pixels(
          ex,
          y,
          [
            [-1, 1],
            [0, 0],
            [1, 1],
          ],
          C.eye,
        );
        break;
      case 'sad':
        c.rect(ex, y, 2, 2, C.eye);
        c.set(ex + (ex < x ? -1 : 2), y - 1, C.eye);
        break;
      case 'focus':
        c.rect(ex, y + 1, 2, 2, C.eye);
        c.rect(ex - 1, y - 1, 4, 1, C.eye);
        break;
      case 'wide':
        c.rect(ex - 1, y - 1, 3, 4, C.eye);
        c.set(ex - 1, y - 1, C.light);
        break;
      default:
        c.rect(ex, y, 2, 3, C.eye);
        c.set(ex, y, C.light);
    }
  }
}

function drawMouth(c, x, y, kind) {
  switch (kind) {
    case 'open':
      c.rect(x - 1, y, 3, 2, C.mouth);
      break;
    case 'flat':
      c.rect(x - 1, y + 1, 3, 1, C.mouth);
      break;
    case 'sad':
      c.pixels(
        x,
        y,
        [
          [-1, 1],
          [0, 0],
          [1, 1],
        ],
        C.mouth,
      );
      break;
    case 'o':
      c.rect(x, y, 2, 2, C.mouth);
      break;
    default:
      c.pixels(
        x,
        y,
        [
          [-2, 0],
          [-1, 1],
          [0, 0],
          [1, 1],
          [2, 0],
        ],
        C.mouth,
      );
  }
}

function drawSprout(c, x, top, sway, droop) {
  const stemTop = top - 4 + droop;
  c.line(x, top, x + sway, stemTop, C.sproutDark);
  const lx = x + sway;
  if (droop > 1) {
    c.ellipse(lx - 3, stemTop + 2, 3, 1.6, C.sprout);
    c.ellipse(lx + 3, stemTop + 2, 3, 1.6, C.sprout);
  } else {
    c.ellipse(lx - 3, stemTop - 1, 3, 1.8, C.sprout);
    c.ellipse(lx + 3, stemTop - 2, 3, 1.8, C.sprout);
    c.set(lx - 4, stemTop - 2, '#e8957a');
    c.set(lx + 2, stemTop - 3, '#e8957a');
  }
}

/**
 * Draw Mochi with a pose description:
 *  dx, dy     body offset (dy < 0 lifts the body)
 *  sx, sy     squash/stretch of the body
 *  look       eye offset left/right
 *  eyes       open | closed | happy | sad | focus | wide
 *  mouth      smile | open | flat | sad | o
 *  arms       [{x, y}, {x, y}] offsets from the default arm spots (null hides an arm)
 *  feet       [dxLeft, dxRight] and optional lifts [dyLeft, dyRight]
 */
function drawMochi(c, p) {
  const sx = p.sx ?? 1;
  const sy = p.sy ?? 1;
  const rx = 14 * sx;
  const ry = 12 * sy;
  const cx = 24 + (p.dx ?? 0);
  const bottom = GROUND - 2 + (p.dy ?? 0);
  const cy = bottom - ry;

  // Feet first so the body overlaps them.
  const [fl, fr] = p.feet ?? [0, 0];
  const [ll, lr] = p.footLift ?? [0, 0];
  c.ellipse(cx - 7 + fl, GROUND - 1 + ll + Math.min(0, p.dy ?? 0), 3.2, 1.8, C.shade);
  c.ellipse(cx + 7 + fr, GROUND - 1 + lr + Math.min(0, p.dy ?? 0), 3.2, 1.8, C.shade);

  // Arms.
  const arms = p.arms ?? [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  const drawArm = (arm, side) => {
    if (!arm) return;
    const ax = cx + side * (rx - 0.5) + arm.x;
    const ay = cy + 3 + arm.y;
    if (arm.raised) {
      // A raised arm is a short tall nub that starts inside the body edge.
      c.ellipse(ax - side * 1.5, ay + 2, 2.2, 3.4, C.body);
      c.ellipse(ax, ay, 2.4, 2.4, C.body);
    } else {
      c.ellipse(ax, ay, 2.6, 2.2, C.body);
    }
  };
  drawArm(arms[0], -1);
  drawArm(arms[1], 1);

  // Body with a soft lower-right shade and a highlight.
  c.ellipse(cx, cy, rx, ry, C.body);
  c.ellipse(cx, cy, rx, ry, C.shade, (x, y) => {
    const nx = (x + 0.5 - (cx - 2.5)) / rx;
    const ny = (y + 0.5 - (cy - 2.5)) / ry;
    return nx * nx + ny * ny > 1;
  });
  c.rect(Math.round(cx - rx * 0.55), Math.round(cy - ry * 0.6), 3, 2, C.light);
  c.set(Math.round(cx - rx * 0.55) - 1, Math.round(cy - ry * 0.6) + 2, C.light);

  drawSprout(c, Math.round(cx + (p.look ?? 0) / 2), Math.round(cy - ry), p.sway ?? 0, p.droop ?? 0);

  const fx = Math.round(cx);
  const fy = Math.round(cy);
  const look = p.look ?? 0;
  drawEyes(c, fx, fy - 1, p.eyes ?? 'open', look);
  if (p.blush !== false) {
    c.rect(fx - 10 + look, fy + 3, 3, 1, C.cheek);
    c.rect(fx + 8 + look, fy + 3, 3, 1, C.cheek);
  }
  drawMouth(c, fx + look, fy + 3, p.mouth ?? 'smile');

  if (p.tear != null) {
    c.rect(fx - 6 + look, fy + 3 + p.tear, 1, 2, C.tear);
    c.rect(fx + 5 + look, fy + 3 + p.tear, 1, 2, C.tear);
  }
  if (p.sweat)
    c.pixels(
      fx + 13,
      fy - 7,
      [
        [0, 0],
        [0, 1],
        [-1, 1],
        [0, 2],
        [-1, 2],
      ],
      C.sweat,
    );
}

const POSES = {
  idle(f) {
    const breathe = [0, 0, 0.04, 0.04, 0.02, 0][f];
    return { sy: 1 - breathe, sx: 1 + breathe / 2, eyes: f === 3 ? 'closed' : 'open', sway: [0, 0, 1, 1, 0, 0][f] };
  },
  'running-right'(f) {
    const bob = [0, -1, -2, -1, 0, -1, -2, -1][f];
    const step = [-2, -1, 0, 1, 2, 1, 0, -1][f];
    return {
      dy: bob,
      look: 2,
      feet: [step, -step],
      footLift: [step > 0 ? -1 : 0, step < 0 ? -1 : 0],
      arms: [
        { x: 0, y: step / 2 },
        { x: 0, y: -step / 2 },
      ],
      sway: -1,
      mouth: 'open',
    };
  },
  waving(f) {
    const up = [
      { x: 1, y: -6, raised: true },
      { x: 2, y: -9, raised: true },
      { x: 1, y: -6, raised: true },
      { x: 2, y: -9, raised: true },
    ][f];
    return { arms: [{ x: 0, y: 0 }, up], eyes: f % 2 ? 'happy' : 'open', mouth: 'open', sway: f % 2 ? 1 : 0 };
  },
  jumping(f) {
    const dy = [1, -4, -8, -4, 1][f];
    const squash = [0.12, -0.06, -0.08, -0.04, 0.1][f];
    return {
      dy: Math.min(dy, 0),
      sy: 1 - squash,
      sx: 1 + squash / 2,
      eyes: f === 0 || f === 4 ? 'closed' : 'happy',
      mouth: 'open',
      arms:
        f === 0 || f === 4
          ? null
          : [
              { x: -1, y: -4 },
              { x: 1, y: -4 },
            ],
      sway: f === 2 ? 1 : 0,
    };
  },
  failed(f) {
    const shake = [0, -1, 0, 1, 0, -1, 0, 1][f];
    return {
      dx: shake,
      sy: 0.9,
      sx: 1.06,
      eyes: 'sad',
      mouth: 'sad',
      droop: 3,
      tear: [0, 0, 1, 1, 2, 2, 3, 3][f],
      arms: [
        { x: 1, y: 2 },
        { x: -1, y: 2 },
      ],
    };
  },
  waiting(f) {
    const bounce = [0, -1, -1, 0, 0, 0][f];
    return {
      dy: bounce,
      look: [0, 1, 1, 1, 0, 0][f],
      eyes: f === 4 ? 'closed' : 'wide',
      mouth: 'o',
      arms: [
        { x: 0, y: 0 },
        { x: 0, y: [-8, -9, -9, -8, -8, -8][f], raised: true },
      ],
      sway: [0, 1, 1, 0, -1, 0][f],
    };
  },
  running(f) {
    const tap = f % 2;
    return {
      dy: [0, 0, -1, 0, 0, -1][f],
      eyes: 'focus',
      mouth: 'flat',
      arms: [
        { x: 2, y: tap ? 1 : -1 },
        { x: -2, y: tap ? -1 : 1 },
      ],
      sway: [0, 1, 0, -1, 0, 1][f],
      sweat: f >= 3,
    };
  },
  review(f) {
    return {
      dx: [0, 0, 1, 1, 0, 0][f],
      look: [-2, -2, 0, 2, 2, 0][f],
      eyes: f === 5 ? 'closed' : 'open',
      mouth: 'flat',
      arms: [
        { x: 0, y: 0 },
        { x: -4, y: -1 },
      ],
      sway: [0, -1, -1, 0, 1, 1][f],
    };
  },
};

module.exports = {
  id: 'mochi',
  displayName: 'Mochi',
  description: 'ふわふわのおもち。Claude Code の作業を見守ります。',
  size: { width: 48, height: 52 },
  outline: C.outline,
  draw(canvas, { state, frame }) {
    drawMochi(canvas, POSES[state](frame));
  },
};
