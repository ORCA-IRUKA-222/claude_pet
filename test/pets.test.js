'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

process.env.CLAUDE_PET_HOME = tempDir();
process.env.CODEX_HOME = tempDir();

const atlas = require('../src/shared/atlas');
const { encodePNG, readImageSize } = require('../src/shared/png');
const { listPets, findPet, createImagePet, loadPet } = require('../src/core/pets');
const { buildPet } = require('../tools/build-pet');

function writePNG(file, width, height) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(width, height, new Uint8Array(width * height * 4)));
}

test('the built-in pet is a valid Codex-size atlas', () => {
  const mochi = findPet('mochi');
  assert.equal(mochi.origin, 'builtin');
  assert.equal(mochi.kind, 'atlas');
  assert.equal(mochi.width, atlas.SHEET_WIDTH);
  assert.equal(mochi.height, atlas.SHEET_HEIGHT);
  assert.equal(mochi.rows, 9);
  assert.equal(mochi.cellWidth, 192);
});

test('Codex pets in $CODEX_HOME/pets are picked up', () => {
  const dir = path.join(process.env.CODEX_HOME, 'pets', 'boba');
  writePNG(path.join(dir, 'spritesheet.png'), 1536, 1872);
  fs.writeFileSync(
    path.join(dir, 'pet.json'),
    JSON.stringify({ id: 'boba', displayName: 'Boba', description: 'tea', spritesheetPath: 'spritesheet.png' }),
  );
  const boba = listPets().find((p) => p.id === 'boba');
  assert.equal(boba.origin, 'codex');
  assert.equal(boba.kind, 'atlas');
});

test('petdex v2 (8x11) sheets load and half-size sheets keep the cell aspect', () => {
  const root = tempDir();
  writePNG(path.join(root, 'v2', 'sheet.png'), 1536, 208 * 11);
  fs.writeFileSync(path.join(root, 'v2', 'pet.json'), JSON.stringify({ spritesheetPath: 'sheet.png' }));
  assert.equal(loadPet(path.join(root, 'v2'), 'custom').rows, 11);

  writePNG(path.join(root, 'half', 'sheet.png'), 768, 936);
  fs.writeFileSync(path.join(root, 'half', 'pet.json'), JSON.stringify({ spritesheetPath: 'sheet.png' }));
  const half = loadPet(path.join(root, 'half'), 'custom');
  assert.deepEqual([half.cellWidth, half.cellHeight, half.rows], [96, 104, 9]);
});

test('invalid packages are skipped', () => {
  const root = tempDir();
  writePNG(path.join(root, 'small', 'sheet.png'), 1536, 400);
  fs.writeFileSync(path.join(root, 'small', 'pet.json'), JSON.stringify({ spritesheetPath: 'sheet.png' }));
  assert.equal(loadPet(path.join(root, 'small'), 'custom'), null);

  fs.mkdirSync(path.join(root, 'escape'));
  fs.writeFileSync(path.join(root, 'escape', 'pet.json'), JSON.stringify({ spritesheetPath: '../small/sheet.png' }));
  assert.equal(loadPet(path.join(root, 'escape'), 'custom'), null);
});

test('createImagePet installs a single image as a pet', () => {
  const image = path.join(tempDir(), 'Neko Chan.png');
  writePNG(image, 300, 280);
  const pet = createImagePet(image, {});
  assert.equal(pet.id, 'neko-chan');
  assert.equal(pet.kind, 'image');
  assert.equal(pet.displayName, 'Neko Chan');
  assert.ok(listPets().some((p) => p.id === 'neko-chan' && p.origin === 'custom'));
  assert.throws(() => createImagePet(__filename), /PNG/);
});

test('build-pet renders a full atlas and contact sheet', () => {
  const out = tempDir();
  const result = buildPet(path.join(__dirname, '..', 'tools', 'designs', 'mochi.js'), { outDir: out });
  assert.deepEqual(result.problems, []);
  const size = readImageSize(fs.readFileSync(path.join(out, 'spritesheet.png')));
  assert.deepEqual([size.width, size.height], [1536, 1872]);
  assert.ok(fs.existsSync(result.contactSheet));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'pet.json'), 'utf8'));
  assert.equal(manifest.spritesheetPath, 'spritesheet.png');
});

test('the committed Mochi spritesheet matches its design', () => {
  const out = tempDir();
  buildPet(path.join(__dirname, '..', 'tools', 'designs', 'mochi.js'), { outDir: out });
  const fresh = fs.readFileSync(path.join(out, 'spritesheet.png'));
  const committed = fs.readFileSync(path.join(__dirname, '..', 'pets', 'mochi', 'spritesheet.png'));
  assert.ok(fresh.equals(committed), 'run `npm run build:pet` after editing tools/designs/mochi.js');
});
