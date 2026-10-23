'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanEnv } = require('../src/shared/env');

test('cleanEnv drops variables that tie a process to the parent Claude Code session', () => {
  const env = cleanEnv(
    {
      PATH: '/usr/bin',
      HOME: '/home/me',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PROJECT_DIR: '/w/app',
      CLAUDE_CONFIG_DIR: '/home/me/.claude',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_PET_PORT: '47717',
    },
    { CLAUDE_PET_SOURCE: 'quickchat' },
  );
  assert.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_PET_PORT',
    'CLAUDE_PET_SOURCE',
    'HOME',
    'PATH',
  ]);
});
