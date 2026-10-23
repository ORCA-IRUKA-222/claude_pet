'use strict';

// When the pet is started from inside Claude Code (for example by `/pet`), it
// inherits variables that describe that session. Passing them on would make a
// quick-chat `claude -p` attach to the parent session, so drop them.

const SESSION_VARS =
  /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|CLAUDE_PROJECT_DIR|CLAUDE_ENV_FILE|CLAUDE_EFFORT|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|TRACEPARENT|TRACESTATE)$/;
const SESSION_SCOPED = /^CLAUDE(_CODE)?_\w*SESSION/;

function cleanEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (SESSION_VARS.test(key) || SESSION_SCOPED.test(key)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}

module.exports = { cleanEnv };
