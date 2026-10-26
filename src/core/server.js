'use strict';

// Local HTTP endpoint for hook events and CLI commands. It binds to 127.0.0.1
// only and refuses browser requests, so web pages can't drive the pet. The one
// exception is the claude.ai browser extension, which may report events only.

const http = require('http');
const { sign } = require('./permissions');

const MAX_BODY = 256 * 1024;
const NONCE = /^[0-9a-f]{32}$/;

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[\w-]+$/;

function allowedHost(header, port) {
  return header === `127.0.0.1:${port}` || header === `localhost:${port}`;
}

/**
 * Start the server. Handlers:
 *   onEvent(event, meta)  hook event from pet-hook.js; meta.fromExtension for the browser extension
 *   onControl(command)    { action, value } from the CLI; may return a JSON-able result
 *   getStatus()           snapshot for `claude-pet status`
 *   onPermission(event, { signal })
 *                         optional; resolves to { behavior: 'allow' | 'deny' } or null (no decision).
 *                         Decisions are signed with `secret` so the hook can trust them.
 */
function startServer({
  port,
  onEvent,
  onControl,
  getStatus,
  onPermission = null,
  secret = null,
  version = '0.0.0',
  build = null,
}) {
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const { origin } = req.headers;
    const fromExtension = typeof origin === 'string' && EXTENSION_ORIGIN.test(origin);
    if ((origin && !(fromExtension && req.method === 'POST' && url === '/event')) || !allowedHost(req.headers.host, port)) {
      return send(res, 403, { error: 'forbidden' });
    }

    try {
      if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, app: 'claude-pet', version, build });
      if (req.method === 'GET' && url === '/status') return send(res, 200, getStatus());

      if (req.method === 'POST' && (url === '/event' || url === '/control' || url === '/permission')) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          return send(res, 415, { error: 'expected application/json' });
        }
        const body = await readBody(req);
        if (url === '/event') {
          onEvent(body, { fromExtension });
          return send(res, 204);
        }
        if (url === '/permission') {
          const event = body && body.event;
          if (!event || typeof event !== 'object' || !NONCE.test(String(body.nonce || '')))
            return send(res, 400, { error: 'bad request' });
          onEvent(event, { permission: Boolean(onPermission && secret) });
          if (!onPermission || !secret) return send(res, 200, {});
          // The hook gives up (or Claude Code kills it) → stop waiting for an answer.
          const controller = new AbortController();
          res.on('close', () => {
            if (!res.writableFinished) controller.abort();
          });
          const decision = await onPermission(event, { signal: controller.signal });
          if (res.destroyed) return undefined;
          if (!decision || (decision.behavior !== 'allow' && decision.behavior !== 'deny')) return send(res, 200, {});
          return send(res, 200, { behavior: decision.behavior, signature: sign(secret, body.nonce, decision.behavior) });
        }
        const result = await onControl(body);
        return send(res, 200, { ok: true, ...(result || {}) });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, err.status || 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

module.exports = { startServer };
