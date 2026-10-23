#!/usr/bin/env node
'use strict';

// Render a code-drawn pet design into a Codex-compatible pet package:
//   <out>/pet.json, <out>/spritesheet.png, <out>/qa/contact-sheet.png
//
// Usage: node tools/build-pet.js <design.js> [--out <dir>] [--install]

const fs = require('fs');
const os = require('os');
const path = require('path');
const atlas = require('../src/shared/atlas');
const { Canvas } = require('./raster');
const { encodePNG } = require('../src/shared/png');

function renderFrames(design) {
  const { width, height } = design.size || { width: 48, height: 52 };
  const scale = atlas.CELL_WIDTH / width;
  if (!Number.isInteger(scale) || atlas.CELL_HEIGHT / height !== scale) {
    throw new Error(`design.size must divide ${atlas.CELL_WIDTH}x${atlas.CELL_HEIGHT} evenly (e.g. 48x52, 96x104)`);
  }

  const rows = {};
  for (const row of atlas.ROWS) {
    const mirror = row.state === 'running-left' && design.mirrorRunningLeft !== false;
    rows[row.state] = [];
    for (let frame = 0; frame < row.frames; frame++) {
      let canvas = new Canvas(width, height);
      const state = mirror ? 'running-right' : row.state;
      design.draw(canvas, { state, frame, frames: row.frames, t: frame / row.frames });
      if (design.outline) canvas.outline(design.outline);
      if (mirror) canvas = canvas.flipX();
      rows[row.state].push(canvas);
    }
  }
  return { rows, scale, width, height };
}

function validate(rendered) {
  const problems = [];
  for (const row of atlas.ROWS) {
    rendered.rows[row.state].forEach((frame, i) => {
      if (frame.isEmpty()) problems.push(`${row.state}[${i}] is empty`);
      for (let x = 0; x < frame.width; x++) {
        if (frame.alpha(x, 0) || frame.alpha(x, frame.height - 1)) {
          problems.push(`${row.state}[${i}] touches the top/bottom edge (may be clipped)`);
          break;
        }
      }
      for (let y = 0; y < frame.height; y++) {
        if (frame.alpha(0, y) || frame.alpha(frame.width - 1, y)) {
          problems.push(`${row.state}[${i}] touches the left/right edge (may be clipped)`);
          break;
        }
      }
    });
  }
  return problems;
}

function composeAtlas(rendered) {
  const sheet = new Canvas(atlas.SHEET_WIDTH, atlas.SHEET_HEIGHT);
  for (const row of atlas.ROWS) {
    rendered.rows[row.state].forEach((frame, col) => {
      sheet.draw(frame.scale(rendered.scale), col * atlas.CELL_WIDTH, row.index * atlas.CELL_HEIGHT);
    });
  }
  return sheet;
}

/** Frames on a checkerboard with cell borders, at 2x logical size, for visual QA. */
function composeContactSheet(rendered) {
  const zoom = 2;
  const cw = rendered.width * zoom;
  const ch = rendered.height * zoom;
  const sheet = new Canvas(cw * atlas.COLUMNS + atlas.COLUMNS + 1, ch * atlas.ROWS.length + atlas.ROWS.length + 1);
  sheet.rect(0, 0, sheet.width, sheet.height, '#9aa0a6');
  for (const row of atlas.ROWS) {
    for (let col = 0; col < atlas.COLUMNS; col++) {
      const ox = 1 + col * (cw + 1);
      const oy = 1 + row.index * (ch + 1);
      const used = col < row.frames;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const light = ((x >> 3) + (y >> 3)) % 2 === 0;
          sheet.set(ox + x, oy + y, used ? (light ? '#ffffff' : '#e6e6e6') : '#c8c8c8');
        }
      }
      if (used) sheet.draw(rendered.rows[row.state][col].scale(zoom), ox, oy);
    }
  }
  return sheet;
}

function writePNG(file, canvas) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(canvas.width, canvas.height, canvas.data));
}

function buildPet(designPath, { outDir, install = false } = {}) {
  const resolved = path.resolve(designPath);
  delete require.cache[resolved];
  const design = require(resolved);
  if (!design.id || !/^[a-z0-9][a-z0-9-]*$/.test(design.id))
    throw new Error('design.id must be lowercase letters, digits and hyphens');
  if (typeof design.draw !== 'function') throw new Error('design.draw(canvas, pose) is required');

  const rendered = renderFrames(design);
  const problems = validate(rendered);
  const target = outDir ? path.resolve(outDir) : path.join(path.dirname(resolved), 'build', design.id);

  writePNG(path.join(target, 'spritesheet.png'), composeAtlas(rendered));
  writePNG(path.join(target, 'qa', 'contact-sheet.png'), composeContactSheet(rendered));
  const manifest = {
    id: design.id,
    displayName: design.displayName || design.id,
    description: design.description || '',
    spritesheetPath: 'spritesheet.png',
    pixelArt: true,
  };
  fs.writeFileSync(path.join(target, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n');

  let installedTo = null;
  if (install) {
    installedTo = path.join(os.homedir(), '.claude-pet', 'pets', design.id);
    fs.mkdirSync(installedTo, { recursive: true });
    fs.copyFileSync(path.join(target, 'spritesheet.png'), path.join(installedTo, 'spritesheet.png'));
    fs.copyFileSync(path.join(target, 'pet.json'), path.join(installedTo, 'pet.json'));
  }

  return { outDir: target, contactSheet: path.join(target, 'qa', 'contact-sheet.png'), problems, installedTo, manifest };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const design = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
  if (!design) {
    console.error('Usage: node tools/build-pet.js <design.js> [--out <dir>] [--install]');
    process.exit(1);
  }
  const outIndex = args.indexOf('--out');
  const result = buildPet(design, {
    outDir: outIndex >= 0 ? args[outIndex + 1] : undefined,
    install: args.includes('--install'),
  });
  console.log(`pet: ${result.manifest.displayName} (${result.manifest.id})`);
  console.log(`package: ${result.outDir}`);
  console.log(`contact sheet: ${result.contactSheet}`);
  if (result.installedTo) console.log(`installed: ${result.installedTo}`);
  if (result.problems.length) {
    console.log('warnings:');
    for (const p of result.problems) console.log(`  - ${p}`);
  } else {
    console.log('validation: ok');
  }
}

module.exports = { buildPet, renderFrames, validate };
