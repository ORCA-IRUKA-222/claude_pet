'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, formatClock, formatSpan } = require('../src/shared/time');
const { parse } = require('../src/shared/markdown');

test('parseDuration understands minutes, units, clocks and Japanese', () => {
  assert.equal(parseDuration('25'), 25 * 60e3);
  assert.equal(parseDuration('10m'), 10 * 60e3);
  assert.equal(parseDuration('90s'), 90e3);
  assert.equal(parseDuration('1h30m'), 90 * 60e3);
  assert.equal(parseDuration('1時間30分'), 90 * 60e3);
  assert.equal(parseDuration('３分'), 3 * 60e3);
  assert.equal(parseDuration('5:00'), 5 * 60e3);
  assert.equal(parseDuration('1:05:00'), 65 * 60e3);
  for (const bad of ['', 'abc', '10x', '0', '5:75', '48h', '10m foo']) assert.equal(parseDuration(bad), null, bad);
});

test('formatClock and formatSpan', () => {
  assert.equal(formatClock(272000), '4:32');
  assert.equal(formatClock(3723000), '1:02:03');
  assert.equal(formatClock(-5), '0:00');
  assert.equal(formatSpan(45e3), '45秒');
  assert.equal(formatSpan(12 * 60e3), '12分');
  assert.equal(formatSpan(65 * 60e3), '1時間5分');
  assert.equal(formatSpan(65 * 60e3, 'en'), '1 h 5 min');
});

test('markdown: blocks', () => {
  const doc = parse('# Title\n\ntext\n\n```js\nconst a = 1;\n```\n\n> quoted\n\n---\n\n| A | B |\n|---|--:|\n| 1 | 2 |');
  assert.deepEqual(
    doc.map((b) => b.type),
    ['heading', 'paragraph', 'code', 'quote', 'hr', 'table'],
  );
  assert.equal(doc[2].lang, 'js');
  assert.equal(doc[2].text, 'const a = 1;');
  assert.deepEqual(doc[5].align, [null, 'right']);
  assert.equal(doc[5].rows.length, 1);
});

test('markdown: nested and task lists, list right after a paragraph', () => {
  const doc = parse('Steps:\n- one\n  - inner\n- [x] done\n- [ ] todo\n\n3. three\n4. four');
  assert.equal(doc[0].type, 'paragraph');
  const list = doc[1];
  assert.equal(list.type, 'list');
  assert.equal(list.items.length, 3);
  assert.equal(list.items[0].blocks[1].type, 'list');
  assert.equal(list.items[1].checked, true);
  assert.equal(list.items[2].checked, false);
  assert.equal(doc[2].ordered, true);
  assert.equal(doc[2].start, 3);
});

test('markdown: inline emphasis, code, links; snake_case stays text', () => {
  const [p] = parse('**bold** *em* ~~gone~~ `x*y` [docs](https://example.com) see https://a.dev/x. my_var_name');
  const types = p.children.map((n) => n.type);
  assert.deepEqual(
    types.filter((t) => t !== 'text'),
    ['strong', 'em', 'del', 'code', 'link', 'link'],
  );
  assert.equal(p.children.find((n) => n.type === 'code').text, 'x*y');
  const bare = p.children.filter((n) => n.type === 'link')[1];
  assert.equal(bare.href, 'https://a.dev/x');
  assert.match(p.children[p.children.length - 1].text, /my_var_name$/);
});

test('markdown: unclosed fences and stray markers do not throw', () => {
  assert.doesNotThrow(() => parse('```\nno end'));
  assert.doesNotThrow(() => parse('** * _ ~~ ` [x]( <'));
  assert.equal(parse('```\nno end')[0].text, 'no end');
});
