'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');
const { normalize, pick } = require('../src/shared/lines');
const { readPacks, linesFor, importPack, summary } = require('../src/core/lines');

test('normalize keeps known scenes and real lines only', () => {
  const lines = normalize({ ready: ['  完了！ ', '', 3, 'おわり'], morning: 'おはよう', dance: ['?'] });
  assert.deepEqual(lines, { ready: ['完了！', 'おわり'], morning: ['おはよう'] });
  assert.deepEqual(normalize(null), {});
});

test('pick fills placeholders and skips lines it cannot fill', () => {
  const lines = { ready: ['{project}、完了よ！'], welcome: ['おかえり！', 'いない間に{summary}よ'] };
  assert.equal(pick(lines, 'ready', { project: 'shop-app' }).text, 'shop-app、完了よ！');
  assert.equal(pick(lines, 'ready', {}), null, 'no project → no line that needs it');
  assert.equal(pick(lines, 'welcome', {}).text, 'おかえり！');
  // with something to tell, lines that tell it come first
  for (let i = 0; i < 5; i++) {
    const line = pick(lines, 'welcome', { summary: '完了 2 件' }, { want: ['summary'] });
    assert.equal(line.text, 'いない間に完了 2 件よ');
    assert.deepEqual(line.uses, ['summary']);
  }
  assert.equal(pick(lines, 'night'), null);
  assert.equal(pick({}, 'ready'), null);
});

test('pick does not say the same line twice in a row', () => {
  const lines = { click: ['a', 'b', 'c'] };
  let previous = null;
  for (let i = 0; i < 30; i++) {
    const { text } = pick(lines, 'click');
    assert.notEqual(text, previous);
    previous = text;
  }
});

test('packs are read from the folder, merged, and matched by id or name', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'a.json'),
    JSON.stringify({ pets: { Saki: { ready: ['勝ったわ'] }, hiro: { click: ['……なに？'] } } }),
  );
  fs.writeFileSync(path.join(dir, 'b.json'), '\uFEFF' + JSON.stringify({ saki: { ready: ['完了よ'], morning: ['おはよう'] } }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  const packs = readPacks(dir);
  assert.deepEqual(packs.saki.ready, ['勝ったわ', '完了よ']);
  assert.deepEqual(linesFor({ id: 'img-1234', displayName: 'saki' }, packs).morning, ['おはよう']);
  assert.deepEqual(linesFor({ id: 'hiro', displayName: '篠澤広' }, packs).click, ['……なに？']);
  assert.deepEqual(linesFor({ id: 'mochi', displayName: 'Mochi' }, packs), {});
  assert.deepEqual(
    summary(packs).find((p) => p.name === 'saki'),
    { name: 'saki', scenes: ['ready', 'morning'], count: 3 },
  );
  assert.deepEqual(readPacks(path.join(dir, 'missing')), {});
});

test('importPack checks the file and copies it into the lines folder', () => {
  const src = path.join(tempDir(), 'gakumas lines.json');
  fs.writeFileSync(src, JSON.stringify({ pets: { saki: { ready: ['完了よ'] } } }));
  const dir = tempDir();
  const result = importPack(src, dir);
  assert.deepEqual(result.pets, ['saki']);
  assert.equal(path.basename(result.target), 'gakumas_lines.json');
  assert.deepEqual(readPacks(dir).saki.ready, ['完了よ']);

  const bad = path.join(tempDir(), 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ pets: { saki: { dance: ['?'] } } }));
  assert.throws(() => importPack(bad, dir), /セリフが見つかりません/);
  fs.writeFileSync(bad, 'not json');
  assert.throws(() => importPack(bad, dir), /JSON/);
});
