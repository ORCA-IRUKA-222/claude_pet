'use strict';

// A reusable chibi-character template. A character is a small data object
// (hair style and colours, eye colour, outfit colour, accessories); the
// template draws all nine animation rows from it so every frame stays on-model.
//
//   const { createChibi } = require('./chibi');
//   module.exports = createChibi({ id: 'hana', displayName: 'Hana', hair: { style: 'bob', color: '#6b4a3a' }, ... });
//
// A file can also export { template: 'chibi', group, characters: [...] } to
// build several characters at once with tools/build-pet.js.

const { parseColor } = require('../raster');

const GROUND = 48;
const HEAD_Y = 19;

function shade(color, amount) {
  const [r, g, b] = parseColor(color);
  const mix = (v) => Math.max(0, Math.min(255, Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)));
  return `#${[mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function palette(ch) {
  const hair = ch.hair.color;
  const skin = ch.skin || '#ffe7d6';
  const outfit = ch.outfit || '#e85a71';
  return {
    outline: ch.outline || '#3b2a2e',
    hair,
    hairShade: ch.hair.shade || shade(hair, -0.22),
    hairLight: ch.hair.light || shade(hair, 0.35),
    skin,
    skinShade: shade(skin, -0.1),
    eye: ch.eyes || '#5a4a8a',
    eyeLight: shade(ch.eyes || '#5a4a8a', 0.35),
    lash: '#3b2a2e',
    outfit,
    outfitShade: shade(outfit, -0.2),
    outfitLight: shade(outfit, 0.45),
    accent: ch.accent || '#ffffff',
    trim: ch.trim || '#ffffff',
    shoes: ch.shoes || shade(outfit, -0.45),
    cheek: '#f59a9a',
    mouth: '#a3404a',
    tear: '#8fd3ff',
    mic: '#6d6f7a',
  };
}

// ------------------------------------------------------------------ body parts

// Bare arms with a shaded edge, so they read against the dress and the face.
function drawArm(c, P, from, to) {
  const out = to.x >= from.x ? 1 : -1;
  c.line(from.x, from.y + 1, to.x, to.y, P.skinShade);
  c.line(from.x + out, from.y + 1, to.x + out, to.y, P.skin);
  c.rect(Math.round(to.x) - (out < 0 ? 1 : 0), Math.round(to.y), 2, 2, P.skin);
  c.ellipse(from.x + 0.5 + out * 0.5, from.y + 0.5, 2.2, 2, P.outfitLight); // puff sleeve
}

function handPosition(arm, shoulder, side, head) {
  // side: -1 = character's right (viewer's left), +1 = viewer's right
  switch (arm) {
    case 'out':
      return { x: shoulder.x + side * 5, y: shoulder.y + 2 };
    case 'up':
      return { x: shoulder.x + side * 8, y: shoulder.y - 8 };
    case 'wave1':
      return { x: shoulder.x + side * 9, y: shoulder.y - 5 };
    case 'wave2':
      return { x: shoulder.x + side * 8, y: shoulder.y - 9 };
    case 'ask':
      return { x: shoulder.x + side * 9, y: shoulder.y - 12 };
    case 'chin':
      return { x: head.x + side * 2, y: head.y + 9 };
    case 'mic':
      return { x: head.x + side * 1, y: head.y + 9 };
    case 'forward':
      return { x: shoulder.x + side * 1, y: shoulder.y + 6 };
    case 'back':
      return { x: shoulder.x + side * 3, y: shoulder.y + 5 };
    case 'droop':
      return { x: shoulder.x + side * 1, y: shoulder.y + 7 };
    default:
      return { x: shoulder.x + side * 2, y: shoulder.y + 6 };
  }
}

function drawTorso(c, P, ch, cx, top, hem) {
  const shorts = ch.outfitStyle === 'shorts';
  for (let y = top; y <= hem; y++) {
    const t = (y - top) / (hem - top);
    const half = shorts ? 4 + Math.round(t * 1.5) : 4 + Math.round(t * 5);
    for (let x = cx - half; x < cx + half; x++) {
      const right = x >= cx + half - 2;
      c.set(x, y, right ? P.outfitShade : P.outfit);
    }
  }
  // collar and bow
  c.rect(cx - 3, top, 6, 1, P.trim);
  c.rect(cx - 2, top + 1, 4, 1, P.trim);
  c.pixels(
    cx,
    top + 1,
    [
      [-2, 0],
      [-1, 1],
      [0, 1],
      [1, 0],
    ],
    P.accent,
  );
  // waist line and hem trim
  const waist = top + 5;
  c.rect(cx - 5, waist, 10, 1, P.accent === P.outfit ? P.outfitShade : P.accent);
  if (shorts) {
    c.rect(cx - 1, hem - 2, 2, 3, P.outfitShade);
  } else {
    for (let x = cx - 9; x < cx + 9; x++) if ((x + hem) % 2 === 0) c.set(x, hem, P.outfitLight);
  }
}

function drawLegs(c, P, cx, hem, legs, lift) {
  const [l, r] = legs;
  for (const [side, leg] of [
    [-1, l],
    [1, r],
  ]) {
    const x = cx + (side < 0 ? -3 : 1) + leg.x;
    const bottom = GROUND - 2 + leg.y + lift;
    c.rect(x, hem + 1, 2, Math.max(1, bottom - hem - 1), P.skin);
    c.rect(x, bottom - 1, 2, 1, '#ffffff');
    c.rect(x - (side < 0 ? 1 : 0), bottom, 3, 2, P.shoes);
  }
}

// ------------------------------------------------------------------ head

function capTop(hx, hy, x) {
  const nx = (x + 0.5 - hx) / 12;
  return nx * nx >= 1 ? null : Math.ceil(hy - 1 - 11 * Math.sqrt(1 - nx * nx) - 0.5);
}

function drawBackHair(c, P, ch, hx, hy, sway) {
  const style = ch.hair.style;
  const wavy = ch.hair.wavy;
  const length = ch.hair.length || 21;
  if (style === 'long' || style === 'long-side') {
    for (let y = hy; y <= hy + length; y++) {
      const bottomTaper = Math.max(0, y - (hy + length - 3));
      const wave = wavy ? Math.floor((y - hy) / 3) % 2 : 0;
      const sw = y > hy + 10 ? sway : 0;
      for (let x = hx - 12 - wave + bottomTaper + sw; x < hx + 12 + wave - bottomTaper + sw; x++) {
        c.set(x, y, y > hy + length - 4 ? P.hairShade : P.hair);
      }
    }
  } else if (style === 'bob') {
    c.ellipse(hx, hy + 3, 12.5, 10.5, P.hair);
    c.ellipse(hx, hy + 3, 12.5, 10.5, P.hairShade, (x, y) => y >= hy + 10);
  } else if (style === 'twintails') {
    for (const side of [-1, 1]) {
      const tx = hx + side * 13 + (side > 0 ? -1 : 0);
      c.ellipse(tx, hy - 4, 2.6, 2.6, P.hair);
      c.ellipse(tx + side * 2 + sway, hy + 2, 3, 6, P.hair);
      c.ellipse(tx + side * 2 + sway, hy + 2, 3, 6, P.hairShade, (x, y) => y >= hy + 5);
      c.rect(Math.round(tx) - 1, hy - 7, 3, 2, P.accent);
    }
  } else if (style === 'low-twintails') {
    for (const side of [-1, 1]) {
      const tx = hx + side * 11 + (side > 0 ? -1 : 0) + sway;
      c.ellipse(tx, hy + 9, 2.6, 7, P.hair);
      c.ellipse(tx, hy + 9, 2.6, 7, P.hairShade, (x, y) => y >= hy + 13);
      c.rect(Math.round(tx) - 1, hy + 2, 2, 2, P.accent);
    }
  } else if (style === 'sidetail-left' || style === 'sidetail-right') {
    const side = style === 'sidetail-left' ? -1 : 1;
    const tx = hx + side * 13 + (side > 0 ? -1 : 0) + sway;
    c.ellipse(tx, hy - 4, 3, 3, P.hair);
    c.ellipse(tx + side, hy + 3, 3.2, 8, P.hair);
    c.ellipse(tx + side, hy + 3, 3.2, 8, P.hairShade, (x, y) => y >= hy + 7);
    c.rect(Math.round(tx) - 1, hy - 7, 3, 2, P.accent);
  } else if (style === 'ponytail') {
    c.ellipse(hx + 10, hy - 7, 3.6, 3.6, P.hair);
    c.ellipse(hx + 13, hy - 1, 3, 5, P.hair);
    c.ellipse(hx + 14 + sway, hy + 8, 3, 9, P.hair);
    c.ellipse(hx + 14 + sway, hy + 8, 3, 9, P.hairShade, (x, y) => y >= hy + 13);
    c.rect(hx + 9, hy - 11, 3, 2, P.accent);
  }
}

function drawFace(c, P, hx, hy) {
  // Bangs: the face shows below a jagged fringe line.
  c.ellipse(hx, hy + 2, 9.6, 8.6, P.skin, (x, y) => {
    const d = Math.abs(x + 0.5 - hx);
    const jag = [1, 2, 1, 0][(Math.floor(x - hx) + 8) % 4];
    return y >= hy - 3 + jag + (d > 7 ? 1 : 0);
  });
}

function drawSideLocks(c, P, ch, hx, hy) {
  const style = ch.hair.style;
  const len = { long: 14, 'long-side': 14, bob: 10, short: 5, ponytail: 9, twintails: 8, 'low-twintails': 9 }[style] ?? 8;
  for (const side of [-1, 1]) {
    const x = side < 0 ? hx - 11 : hx + 9;
    c.rect(x, hy - 1, 2, len, P.hair);
    c.set(side < 0 ? x + 1 : x, hy - 1 + len, P.hairShade);
    c.rect(x, hy - 1 + len - 2, 2, 2, P.hairShade);
  }
  if (style === 'long-side') {
    // one long lock falling over the shoulder in front
    c.rect(hx + 8, hy + 6, 3, 13, P.hair);
    c.rect(hx + 8, hy + 16, 3, 3, P.hairShade);
  }
}

function drawHairTop(c, P, ch, hx, hy) {
  c.ellipse(hx, hy - 1, 12, 11, P.hair, (x, y) => y < hy + 3);
  // shine band
  for (const [x0, x1] of [
    [-6, -2],
    [2, 5],
  ]) {
    for (let x = hx + x0; x <= hx + x1; x++) c.set(x, hy - 7 + (x === hx + x0 || x === hx + x1 ? 1 : 0), P.hairLight);
  }
  if (ch.accessories.includes('ahoge'))
    c.pixels(
      hx + 1,
      hy - 11,
      [
        [0, 0],
        [1, -1],
        [2, -1],
        [0, 1],
      ],
      P.hair,
    );
}

function drawEyes(c, P, hx, hy, kind, look) {
  const y = hy + 1;
  for (const [x0, inner] of [
    [hx - 6 + look, 1],
    [hx + 3 + look, -1],
  ]) {
    switch (kind) {
      case 'closed':
        c.rect(x0, y + 2, 3, 1, P.lash);
        break;
      case 'happy':
        c.pixels(
          x0,
          y,
          [
            [0, 2],
            [1, 1],
            [2, 2],
          ],
          P.lash,
        );
        break;
      case 'sad':
        c.rect(x0, y + 2, 3, 2, P.eye);
        c.set(x0 + 1, y + 2, '#ffffff');
        if (inner > 0)
          c.pixels(
            x0,
            y,
            [
              [0, 1],
              [1, 1],
              [2, 0],
            ],
            P.lash,
          );
        else
          c.pixels(
            x0,
            y,
            [
              [0, 0],
              [1, 1],
              [2, 1],
            ],
            P.lash,
          );
        break;
      case 'focus':
        c.rect(x0, y + 1, 3, 1, P.lash);
        c.rect(x0, y + 2, 3, 1, P.eye);
        break;
      default:
        c.rect(x0, y, 3, 1, P.lash);
        c.rect(x0, y + 1, 3, 2, P.eye);
        c.rect(x0, y + 3, 3, 1, P.eyeLight);
        c.set(x0, y + 1, '#ffffff');
        if (kind === 'wide') c.set(x0 + 2, y + 3, '#ffffff');
    }
  }
}

function drawMouth(c, P, hx, hy, kind, look) {
  const x = hx - 1 + look;
  const y = hy + 6;
  switch (kind) {
    case 'open':
    case 'sing':
      c.rect(x, y, 2, 2, P.mouth);
      c.set(x + (kind === 'sing' ? 1 : 0), y + 1, '#f08a8a');
      break;
    case 'flat':
      c.rect(x, y, 2, 1, P.mouth);
      break;
    case 'sad':
      c.pixels(
        x,
        y,
        [
          [-1, 1],
          [0, 0],
          [1, 0],
          [2, 1],
        ],
        P.mouth,
      );
      break;
    case 'o':
      c.rect(x, y, 2, 2, P.mouth);
      break;
    default:
      c.pixels(
        x,
        y,
        [
          [-1, 0],
          [0, 1],
          [1, 1],
          [2, 0],
        ],
        P.mouth,
      );
  }
}

function drawAccessories(c, P, ch, hx, hy, look) {
  const acc = ch.accessories;
  if (acc.includes('ribbons')) {
    const bow = [
      [-2, -1],
      [-2, 0],
      [-2, 1],
      [-1, 0],
      [-1, -1],
      [0, 0],
      [1, 0],
      [1, -1],
      [2, -1],
      [2, 0],
      [2, 1],
    ];
    for (const side of [-1, 1]) c.pixels(hx + side * 11 + (side > 0 ? -1 : 0), hy - 6, bow, P.accent);
  }
  if (acc.includes('headband')) {
    for (let x = hx - 10; x < hx + 10; x++) {
      const top = capTop(hx, hy, x);
      if (top == null) continue;
      c.set(x, top + 2, P.accent);
      c.set(x, top + 3, shade(P.accent, -0.15));
    }
  }
  if (acc.includes('hairclip')) c.rect(hx + 5, hy - 4, 3, 1, P.accent);
  if (acc.includes('glasses')) {
    const y = hy;
    for (const x0 of [hx - 7 + look, hx + 2 + look]) {
      c.rect(x0, y, 5, 1, ch.glasses || '#7a3b3b');
      c.rect(x0, y + 5, 5, 1, ch.glasses || '#7a3b3b');
      c.rect(x0, y, 1, 6, ch.glasses || '#7a3b3b');
      c.rect(x0 + 4, y, 1, 6, ch.glasses || '#7a3b3b');
    }
    c.rect(hx - 2 + look, y + 1, 4, 1, ch.glasses || '#7a3b3b');
  }
}

function drawBunny(c, hand) {
  const x = Math.round(hand.x) - 2;
  const y = Math.round(hand.y) - 1;
  c.ellipse(x + 1, y + 4, 2.8, 3.2, '#ffd6ea');
  c.rect(x - 1, y - 2, 1, 4, '#ffd6ea');
  c.rect(x + 2, y - 2, 1, 4, '#ffd6ea');
  c.set(x, y + 3, '#3b2a2e');
  c.set(x + 2, y + 3, '#3b2a2e');
}

// ------------------------------------------------------------------ the whole character

function drawCharacter(c, ch, P, p) {
  const dx = p.dx ?? 0;
  const dy = p.dy ?? 0;
  const cx = 24 + dx;
  const hx = cx + (p.headDx ?? 0);
  const hy = HEAD_Y + dy + (p.headDy ?? 0);
  const top = 30 + dy + (p.crouch ?? 0);
  const hem = 42 + Math.min(dy, 0) + (p.crouch ?? 0);
  const look = p.look ?? 0;
  const sway = p.sway ?? 0;
  const legStep = p.legs ?? [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  drawBackHair(c, P, ch, hx, hy, sway);
  drawLegs(c, P, cx, hem, legStep, Math.min(dy, 0));
  drawTorso(c, P, ch, cx, top, hem);

  const shoulders = [
    { x: cx - 5, y: top + 2 },
    { x: cx + 4, y: top + 2 },
  ];
  const head = { x: hx, y: hy };
  const [armR, armL] = p.arms ?? ['down', 'down'];
  const handR = handPosition(armR, shoulders[0], -1, head);
  const handL = handPosition(armL, shoulders[1], 1, head);

  drawHairTop(c, P, ch, hx, hy);
  drawFace(c, P, hx, hy);
  drawSideLocks(c, P, ch, hx, hy);
  drawEyes(c, P, hx, hy, p.eyes ?? 'open', look);
  if (p.blush !== false) {
    c.rect(hx - 8 + look, hy + 5, 2, 1, P.cheek);
    c.rect(hx + 6 + look, hy + 5, 2, 1, P.cheek);
  }
  drawMouth(c, P, hx, hy, p.mouth ?? 'smile', look);
  if (p.tear != null) {
    c.rect(hx - 5 + look, hy + 5 + p.tear, 1, 2, P.tear);
    c.rect(hx + 4 + look, hy + 5 + p.tear, 1, 2, P.tear);
  }
  drawAccessories(c, P, ch, hx, hy, look);

  if (ch.accessories.includes('bunny') && armL !== 'up' && armL !== 'out') drawBunny(c, handL);
  drawArm(c, P, shoulders[0], handR);
  drawArm(c, P, shoulders[1], handL);
  if (armR === 'mic') {
    c.rect(Math.round(handR.x), Math.round(handR.y) - 3, 2, 2, P.mic);
    c.set(Math.round(handR.x), Math.round(handR.y) - 3, '#b8bac4');
  }
}

// ------------------------------------------------------------------ poses per animation row

function walk(f, dir) {
  const step = [2, 1, 0, -1, -2, -1, 0, 1][f] * dir;
  return {
    dy: [0, -1, 0, -1, 0, -1, 0, -1][f],
    look: dir,
    headDx: dir,
    sway: -dir,
    legs: [
      { x: Math.round(step / 2), y: step * dir > 0 ? -1 : 0 },
      { x: -Math.round(step / 2), y: step * dir < 0 ? -1 : 0 },
    ],
    arms: step * dir > 0 ? ['back', 'forward'] : ['forward', 'back'],
    mouth: 'open',
  };
}

const POSES = {
  idle: (f) => ({
    headDy: [0, 0, 1, 1, 0, 0][f],
    eyes: f === 3 ? 'closed' : 'open',
    sway: [0, 0, 1, 1, 0, 0][f],
  }),
  'running-right': (f) => walk(f, 1),
  'running-left': (f) => walk(f, -1),
  waving: (f) => ({
    arms: ['down', f % 2 ? 'wave2' : 'wave1'],
    eyes: f % 2 ? 'happy' : 'open',
    mouth: 'open',
    headDx: f % 2 ? 1 : 0,
  }),
  jumping: (f) => ({
    dy: [0, -3, -5, -3, 0][f],
    crouch: f === 0 || f === 4 ? 1 : 0,
    headDy: f === 0 || f === 4 ? 1 : 0,
    eyes: f === 0 || f === 4 ? 'closed' : 'happy',
    mouth: 'open',
    arms: f === 0 || f === 4 ? ['out', 'out'] : ['up', 'up'],
    legs:
      f === 2
        ? [
            { x: -1, y: -1 },
            { x: 1, y: -1 },
          ]
        : undefined,
  }),
  failed: (f) => ({
    dx: [0, 0, -1, 0, 1, 0, 0, 0][f],
    headDy: 1,
    eyes: 'sad',
    mouth: 'sad',
    arms: ['droop', 'droop'],
    tear: [0, 0, 1, 1, 2, 2, 3, 3][f],
  }),
  waiting: (f) => ({
    dy: [0, -1, -1, 0, 0, 0][f],
    headDx: [0, 1, 1, 1, 0, 0][f],
    eyes: f === 4 ? 'closed' : 'wide',
    mouth: 'o',
    arms: ['down', 'ask'],
  }),
  running: (f) => ({
    headDx: [0, 1, 1, 0, -1, -1][f],
    eyes: f % 3 === 2 ? 'happy' : 'closed',
    mouth: f % 2 ? 'sing' : 'open',
    arms: ['mic', f % 2 ? 'out' : 'down'],
    sway: [0, 1, 1, 0, -1, -1][f],
  }),
  review: (f) => ({
    look: [-1, -1, 0, 1, 1, 0][f],
    eyes: f === 5 ? 'closed' : 'open',
    mouth: 'flat',
    arms: ['chin', 'down'],
  }),
};

function createChibi(character) {
  const ch = { accessories: [], ...character, hair: { style: 'bob', color: '#6b4a3a', ...(character.hair || {}) } };
  const P = palette(ch);
  return {
    id: ch.id,
    displayName: ch.displayName || ch.id,
    description: ch.description || '',
    group: ch.group,
    size: { width: 48, height: 52 },
    outline: P.outline,
    mirrorRunningLeft: false,
    draw(canvas, { state, frame }) {
      drawCharacter(canvas, ch, P, POSES[state](frame));
    },
  };
}

module.exports = { createChibi, shade };
