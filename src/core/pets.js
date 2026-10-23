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
  };

  const sheetName = manifest.spritesheetPath || manifest.spritesheet;
  const imageName = manifest.imagePath || manifest.image;
  const kind = sheetName ? 'atlas' : imageName ? 'image' : null;
  if (!kind) return null;

  const file = path.resolve(dir, String(sheetName || imageName));
  if (!insideDir(dir, file) || !fs.existsSync(file)) return null;

  let size = null;
  try {
    const fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    fs.closeSync(fd);
    size = readImageSize(header);
  } catch {
    return null;
  }
  if (!size) return null;

  if (kind === 'image') return { ...base, kind, file, width: size.width, height: size.height };

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

/** Install a single transparent image as a pet under ~/.claude-pet/pets/<id>. */
function createImagePet(imagePath, { name, description = '' } = {}) {
  const source = path.resolve(imagePath);
  const header = fs.readFileSync(source).subarray(0, 64);
  const size = readImageSize(header);
  if (!size) throw new Error('PNG / WebP / GIF の画像を指定してください');

  const displayName = name || path.basename(source, path.extname(source));
  const id = slugify(displayName);
  const dir = path.join(homeDir(), 'pets', id);
  fs.mkdirSync(dir, { recursive: true });
  const imageFile = `pet.${size.format}`;
  fs.copyFileSync(source, path.join(dir, imageFile));
  const manifest = { id, displayName, description, kind: 'image', imagePath: imageFile };
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n');
  return loadPet(dir, 'custom');
}

module.exports = { petRoots, loadPet, listPets, findPet, createImagePet, slugify };
