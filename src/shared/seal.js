'use strict';

// End-to-end encryption for events relayed through a public pub/sub server (ntfy): the relay
// only sees ciphertext. AES-256-GCM with a key that stays on your computer and in the cloud
// environment's setup script.

const crypto = require('crypto');

const PREFIX = 'cp1.';
const TOPIC = /^[A-Za-z0-9_-]{16,64}$/;

function newKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function newTopic() {
  return `claude-pet-${crypto.randomBytes(18).toString('base64url')}`;
}

function keyBytes(key) {
  const bytes = Buffer.from(String(key || ''), 'base64url');
  if (bytes.length !== 32) throw new Error('invalid key');
  return bytes;
}

function seal(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The sealed value, or null for anything that wasn't sealed with this key. */
function unseal(text, key) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(text.slice(PREFIX.length), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(key), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { seal, unseal, newKey, newTopic, TOPIC };
