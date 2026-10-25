'use strict';

// Local HTTP endpoint for hook events and CLI commands. It binds to 127.0.0.1
// only and refuses browser requests, so web pages can't drive the pet.

const http = require('http');

const MAX_BODY = 256 * 1024;

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

function allowedHost(header, port) {
  return header === `127.0.0.1:${port}` || header === `localhost:${port}`;
}

/**
 * Start the server. Handlers:
 *   onEvent(event)        hook event from pet-hook.js
 *   onControl(command)    { action, value } from the CLI; may return a JSON-able result
 *   getStatus()           snapshot for `claude-pet status`
 */
function startServer({ port, onEvent, onControl, getStatus, version = '0.0.0', build = null }) {
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin || !allowedHost(req.headers.host, port)) return send(res, 403, { error: 'forbidden' });

    const url = req.url.split('?')[0];
    try {
      if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, app: 'claude-pet', version, build });
      if (req.method === 'GET' && url === '/status') return send(res, 200, getStatus());

      if (req.method === 'POST' && (url === '/event' || url === '/control')) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          return send(res, 415, { error: 'expected application/json' });
        }
        const body = await readBody(req);
        if (url === '/event') {
          onEvent(body);
          return send(res, 204);
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
