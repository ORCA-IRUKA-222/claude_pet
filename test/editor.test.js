'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findOnPath, openInEditor } = require('../src/core/editor');
const { tempDir } = require('./helpers');

test('findOnPath finds executables in PATH directories', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'code'), '#!/bin/sh\n');
  assert.equal(findOnPath('code', { env: { PATH: `/nope${path.delimiter}${dir}` }, platform: 'linux' }), path.join(dir, 'code'));
  assert.equal(findOnPath('cursor', { env: { PATH: dir }, platform: 'linux' }), null);
  fs.writeFileSync(path.join(dir, 'code.cmd'), '');
  assert.equal(findOnPath('code', { env: { PATH: dir }, platform: 'win32' }), path.join(dir, 'code.cmd'));
});

test('openInEditor refuses missing or relative files', async () => {
  await assert.rejects(openInEditor('relative.js'), /not found/);
  await assert.rejects(openInEditor(path.join(tempDir(), 'missing.js')), /not found/);
});

test('file names cannot inject shell commands', () => {
  const { quoteForShell } = require('../src/core/editor');
  assert.equal(quoteForShell('/w/a b.js', 'linux'), "'/w/a b.js'");
  assert.equal(quoteForShell("/w/$(rm -rf ~)'x.js", 'linux'), "'/w/$(rm -rf ~)'\\''x.js'");
  assert.equal(quoteForShell('C:\\w\\a b.js', 'win32'), '"C:\\w\\a b.js"');
  assert.throws(() => quoteForShell('C:\\w\\%PATH%.js', 'win32'), /unsafe/);
  assert.throws(() => quoteForShell('C:\\w\\a&calc.js', 'win32'), /unsafe/);
});
