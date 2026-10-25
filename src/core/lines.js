'use strict';

// Line packs: JSON files in ~/.claude-pet/lines/ that give pets something to say.
//
//   { "pets": { "saki": { "ready": ["{project}、完了よ！"], "morning": ["おはよう！"] } } }
//
// A pet is matched by its id or display name (case-insensitive), so a pack written for
// pets made from saki.png, temari.png, … works however they were imported.

const fs = require('fs');
const path = require('path');
const { homeDir } = require('../shared/config');
const { normalize, SCENES } = require('../shared/lines');

const MAX_BYTES = 2 * 1024 * 1024;

function linesDir() {
  return path.join(homeDir(), 'lines');
}

/** The pets of one pack file: name → scenes. Accepts { pets: {...} } or the map itself. */
function petsOf(data) {
  if (!data || typeof data !== 'object') return {};
  const map = data.pets && typeof data.pets === 'object' ? data.pets : data;
  const out = {};
  for (const [name, lines] of Object.entries(map)) {
    const clean = normalize(lines);
    if (Object.keys(clean).length) out[name.trim().toLowerCase()] = clean;
  }
  return out;
}

/** Every pack in the folder, merged: later files (by name) add lines to the same pet. */
function readPacks(dir = linesDir()) {
  const packs = {};
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .sort();
  } catch {
    return packs;
  }
  for (const file of files) {
    let data;
    try {
      const full = path.join(dir, file);
      if (fs.statSync(full).size > MAX_BYTES) continue;
      data = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue; // a broken file shouldn't silence the other pets
    }
    for (const [name, scenes] of Object.entries(petsOf(data))) {
      const merged = packs[name] || {};
      for (const [scene, list] of Object.entries(scenes)) merged[scene] = [...(merged[scene] || []), ...list];
      packs[name] = merged;
    }
  }
  return packs;
}

/** The lines for a pet (empty when it has none). */
function linesFor(pet, packs = readPacks()) {
  if (!pet) return {};
  for (const name of [pet.id, pet.displayName, pet.key]) {
    const found = name && packs[String(name).trim().toLowerCase()];
    if (found) return normalize(found);
  }
  return {};
}

/** Check a pack file and copy it into the lines folder. */
function importPack(file, dir = linesDir()) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON として読めませんでした: ${err.message}`);
  }
  const pets = petsOf(data);
  if (!Object.keys(pets).length)
    throw new Error('セリフが見つかりませんでした（{ "pets": { "名前": { "ready": [...] } } } の形にしてください）');
  fs.mkdirSync(dir, { recursive: true });
  const name =
    path
      .basename(file)
      .replace(/[^\w.-]+/g, '_')
      .replace(/\.json$/i, '') || 'lines';
  const target = path.join(dir, `${name}.json`);
  fs.writeFileSync(target, JSON.stringify({ pets: data.pets || data }, null, 2) + '\n');
  return { target, pets: Object.keys(pets) };
}

/** Which pets have lines, and how many: for `claude-pet lines`. */
function summary(packs = readPacks()) {
  return Object.entries(packs).map(([name, scenes]) => ({
    name,
    scenes: Object.keys(SCENES).filter((s) => scenes[s]),
    count: Object.values(scenes).reduce((n, list) => n + list.length, 0),
  }));
}

module.exports = { linesDir, readPacks, linesFor, importPack, summary, petsOf };
