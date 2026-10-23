'use strict';
// One-time QR pairing codes. Codes are 32 random bytes (base64url), kept only as sha256 hashes in memory (never on
// disk, never logged), single use, 5-minute TTL. A server restart simply invalidates outstanding codes.
const crypto = require('crypto');
const TTL_MS = 5 * 60e3, MAX_ACTIVE = 5;
const active = new Map(); // hash -> expiresAt
const hash = (code) => crypto.createHash('sha256').update('md-pair:' + code).digest('hex');
function prune(now = Date.now()) { for (const [h, exp] of active) if (exp <= now) active.delete(h); }
function create(now = Date.now()) {
  prune(now);
  while (active.size >= MAX_ACTIVE) active.delete(active.keys().next().value); // oldest first
  const code = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + TTL_MS;
  active.set(hash(code), expiresAt);
  return { code, expiresAt };
}
// Returns true once per code; the code is burned on success.
function redeem(code, now = Date.now()) {
  prune(now);
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
  const h = hash(code);
  if (!active.has(h)) return false;
  active.delete(h);
  return true;
}
module.exports = { TTL_MS, create, redeem, _active: active };
