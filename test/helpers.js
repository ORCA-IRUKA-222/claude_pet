'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

function tempDir(prefix = 'claude-pet-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

module.exports = { tempDir, freePort };
