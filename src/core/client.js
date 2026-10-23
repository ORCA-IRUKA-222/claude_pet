'use strict';

// Talks to a running pet app over its localhost endpoint.

const http = require('http');
const { getPort } = require('../shared/config');

function request(method, urlPath, body, { timeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: getPort(),
        path: urlPath,
        method,
        timeout,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

async function isRunning() {
  try {
    const res = await request('GET', '/health', undefined, { timeout: 800 });
    return res.status === 200 && res.json && res.json.app === 'claude-pet';
  } catch {
    return false;
  }
}

async function control(action, value) {
  const res = await request('POST', '/control', { action, value });
  if (res.status !== 200) throw new Error((res.json && res.json.error) || `HTTP ${res.status}`);
  return res.json;
}

async function status() {
  const res = await request('GET', '/status');
  return res.json;
}

module.exports = { request, isRunning, control, status };
