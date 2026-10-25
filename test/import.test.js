'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tempDir } = require('./helpers');

process.env.CLAUDE_PET_HOME = tempDir();
const { importFolder, createImagePet, hasAlpha, listPets } = require('../src/core/pets');
const { encodePNG, crc32 } = require('../src/shared/png');

const transparent = () => encodePNG(4, 6, new Uint8Array(4 * 6 * 4));

/** A PNG without an alpha channel (colour type 2), like a screenshot. */
function opaque() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const raw = Buffer.from([0, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a folder of pictures becomes a group of pets, once', () => {
  const folder = path.join(tempDir(), '学園アイドルマスター');
  fs.mkdirSync(path.join(folder, '藤田ことね'), { recursive: true });
  fs.writeFileSync(path.join(folder, '花海咲季.png'), transparent());
  fs.writeFileSync(path.join(folder, '月村手毬.png'), opaque());
  fs.writeFileSync(path.join(folder, '有村麻央.jpg'), 'jpeg');
  fs.writeFileSync(path.join(folder, 'memo.txt'), 'not a picture');
  fs.writeFileSync(path.join(folder, '藤田ことね', 'default.png'), transparent());
  fs.writeFileSync(path.join(folder, '藤田ことね', 'running.png'), transparent());

  // Saki was added by hand before: the import updates her instead of adding a second one
  const sakiFile = path.join(tempDir(), 'default.png');
  fs.writeFileSync(sakiFile, transparent());
  createImagePet(sakiFile, { id: 'saki', name: '花海咲季', group: '学園アイドルマスター', height: 320 });

  const first = importFolder(folder, { height: 320 });
  assert.equal(first.group, '学園アイドルマスター');
  assert.deepEqual(first.added.map((p) => p.displayName).sort(), ['月村手毬', '花海咲季', '藤田ことね'].sort());
  assert.equal(first.added.find((p) => p.displayName === '花海咲季').id, 'saki');
  assert.ok(first.added.every((p) => /^[a-z0-9][a-z0-9-]*$/.test(p.id)));
  assert.deepEqual(
    first.opaque.map((f) => path.basename(f)),
    ['月村手毬.png'],
  );
  assert.deepEqual(first.skipped, [{ file: path.join(folder, '有村麻央.jpg'), reason: 'jpeg' }]);
  const kotone = first.added.find((p) => p.displayName === '藤田ことね');
  assert.ok(kotone.states && kotone.states.running, 'running.png becomes the running picture');

  const before = listPets().length;
  const second = importFolder(folder, { height: 320 });
  assert.deepEqual(second.added.map((p) => p.id).sort(), first.added.map((p) => p.id).sort());
  assert.equal(listPets().length, before, 'importing again adds no copies');
});

test('transparency is read from the file', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.png'), transparent());
  fs.writeFileSync(path.join(dir, 'b.png'), opaque());
  assert.equal(hasAlpha(path.join(dir, 'a.png')), true);
  assert.equal(hasAlpha(path.join(dir, 'b.png')), false);
});
