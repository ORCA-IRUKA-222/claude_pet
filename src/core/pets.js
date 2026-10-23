'use strict';

// Finds installed pets. Two package kinds are supported:
//   atlas  pet.json + spritesheet (Codex / ChatGPT / Petdex format, 8 columns of 192x208 cells)
//   image  pet.json + a single transparent PNG/WebP/GIF, animated by the app

const fs = require('fs');
const os = require('os');
const path = require('path');
const atlas = require('../shared/atlas');
const { APP_ROOT, homeDir, readJSON } = require('../shared/config');
const { readImageSize } = require('../shared/png');

function petRoots() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [
    { dir: path.join(homeDir(), 'pets'), origin: 'custom' },
    { dir: path.join(codexHome, 'pets'), origin: 'codex' },
    { dir: path.join(os.homedir(), '.petdex', 'pets'), origin: 'petdex' },
    { dir: path.join(APP_ROOT, 'pets'), origin: 'builtin' },
  ];
}

function insideDir(dir, file) {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Names an image pet can give per-state pictures for: animation rows and pet statuses.
const IMAGE_STATES = new Set([
  'idle',
  'running',
  'review',
  'waiting',
  'failed',
  'ready',
  'jumping',
  'waving',
  'running-left',
  'running-right',
]);

function readSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    fs.closeSync(fd);
    return readImageSize(header);
  } catch {
    return null;
  }
}

/** Resolve an image inside the pet folder; null if it is missing, outside, or unreadable. */
function imageInfo(dir, name) {
  if (!name) return null;
  const file = path.resolve(dir, String(name));
  if (!insideDir(dir, file) || !fs.existsSync(file)) return null;
  const size = readSize(file);
  return size ? { file, width: size.width, height: size.height } : null;
}

function loadPet(dir, origin) {
  const manifest = readJSON(path.join(dir, 'pet.json'), null);
  if (!manifest || typeof manifest !== 'object') return null;

  const id = String(manifest.id || path.basename(dir));
  const base = {
    id,
    displayName: String(manifest.displayName || manifest.name || id),
    description: String(manifest.description || ''),
    origin,
    dir,
    pixelArt: Boolean(manifest.pixelArt),
    group: manifest.group ? String(manifest.group) : null,
  };

  const sheetName = manifest.spritesheetPath || manifest.spritesheet;
  const imageName = manifest.imagePath || manifest.image;
  const kind = sheetName ? 'atlas' : imageName ? 'image' : null;
  if (!kind) return null;

  const main = imageInfo(dir, sheetName || imageName);
  if (!main) return null;
  const { file } = main;
  const size = main;

  if (kind === 'image') {
    // Illustrations can set their on-screen height (px at the largest size) and per-state pictures.
    const states = {};
    for (const [state, name] of Object.entries(manifest.states || {})) {
      const info = IMAGE_STATES.has(state) ? imageInfo(dir, name) : null;
      if (info) states[state] = info;
    }
    const displayHeight = Number(manifest.height);
    return {
      ...base,
      kind,
      file,
      width: size.width,
      height: size.height,
      states,
      displayHeight: Number.isFinite(displayHeight) ? Math.min(Math.max(displayHeight, 80), 900) : null,
    };
  }

  // Atlas: 8 columns; cells keep the 192:208 aspect so scaled sheets work too.
  if (size.width % atlas.COLUMNS !== 0) return null;
  const cellWidth = size.width / atlas.COLUMNS;
  const cellHeight = Math.round((cellWidth * atlas.CELL_HEIGHT) / atlas.CELL_WIDTH);
  const rows = Math.floor(size.height / cellHeight);
  if (rows < atlas.ROWS.length) return null;
  return { ...base, kind, file, width: size.width, height: size.height, cellWidth, cellHeight, rows };
}

function listPets() {
  const pets = [];
  const seen = new Set();
  for (const { dir, origin } of petRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pet = loadPet(path.join(dir, entry.name), origin);
      if (!pet) continue;
      pet.key = seen.has(pet.id) ? `${origin}/${pet.id}` : pet.id;
      seen.add(pet.id);
      pets.push(pet);
    }
  }
  return pets;
}

function findPet(key) {
  const pets = listPets();
  return (
    pets.find((p) => p.key === key) ||
    pets.find((p) => p.id === key) ||
    pets.find((p) => p.origin === 'builtin') ||
    pets[0] ||
    null
  );
}

function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `pet-${Date.now().toString(36)}`;
}

/**
 * Install a transparent image (an illustration, a sticker...) as a pet under ~/.claude-pet/pets/<id>.
 * `states` maps a state (idle, running, waiting, ready, failed, ...) to another image for that state.
 */
function createImagePet(imagePath, { id: wantedId, name, description = '', group = null, height = null, states = {} } = {}) {
  const copyImage = (source, base) => {
    const size = readSize(path.resolve(source));
    if (!size) throw new Error(`PNG / WebP / GIF の画像を指定してください: ${source}`);
    const fileName = `${base}.${size.format}`;
    fs.copyFileSync(path.resolve(source), path.join(dir, fileName));
    return fileName;
  };
  const source = path.resolve(imagePath);
  if (!readSize(source)) throw new Error('PNG / WebP / GIF の画像を指定してください');
  for (const state of Object.keys(states)) {
    if (!IMAGE_STATES.has(state)) throw new Error(`知らない状態です: ${state}（${[...IMAGE_STATES].join(', ')}）`);
  }

  const displayName = name || path.basename(source, path.extname(source));
  if (wantedId && !/^[a-z0-9][a-z0-9-]*$/.test(wantedId)) throw new Error('--id は英小文字・数字・ハイフンで指定してください');
  const id = wantedId || slugify(displayName);
  const dir = path.join(homeDir(), 'pets', id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id, displayName, description, kind: 'image', imagePath: copyImage(source, 'pet') };
  if (group) manifest.group = group;
  if (height) manifest.height = Number(height);
  const stateFiles = {};
  for (const [state, file] of Object.entries(states)) stateFiles[state] = copyImage(file, `state-${state}`);
  if (Object.keys(stateFiles).length) manifest.states = stateFiles;
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n');
  return loadPet(dir, 'custom');
}

module.exports = { petRoots, loadPet, listPets, findPet, createImagePet, slugify };
