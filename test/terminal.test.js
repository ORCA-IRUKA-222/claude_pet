'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');
const { openInTerminal, powerShellString } = require('../src/core/terminal');

test('PowerShell strings keep any task text literal', () => {
  assert.equal(powerShellString(`it's $HOME; & rm -r "x"`), `'it''s $HOME; & rm -r "x"'`);
});

test('a free-text argument reaches claude as one quoted argument', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  const out = path.join(dir, 'args.txt');
  // a terminal template that runs the command directly and records its arguments
  const recorder = path.join(dir, 'claude');
  fs.writeFileSync(recorder, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${JSON.stringify(out)}\n`);
  fs.chmodSync(recorder, 0o755);
  await openInTerminal({
    cwd: dir,
    claudePath: recorder,
    template: '{command}',
    args: ['--cloud', `it's "quoted"; $HOME & more`],
  });
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split('\n'), ['--cloud', `it's "quoted"; $HOME & more`]);
});
