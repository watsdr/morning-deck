'use strict';
// "Stay signed in" keys for the installed app (PWA / private APK). A signed-in device asks once for a long random
// key and keeps it in IndexedDB (survives service-worker cache updates). When its cookie is gone, the lock page or
// the service worker trades the key for a fresh cookie at POST /signin/renew. Only sha256 hashes are stored
// (<data>/device-keys.json, 600). Each key lives at most 180 days from when the phone session began (it never
// extends the session). Rotating MD_TOKEN invalidates every key (hash is bound to the token-derived cookie value).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const FILE = path.join(core.DATA_DIR, 'device-keys.json');
const MAX_AGE_MS = 180 * 86400e3, MAX_KEYS = 10;
let bind = '';
const setBinding = (b) => { bind = String(b || ''); };
const H = (k) => crypto.createHash('sha256').update('md-devkey:' + bind + ':' + k).digest('hex');
function load() { try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
const live = (now = Date.now()) => load().filter((r) => r.expiresAt > now);
function issue(ua, sessionStart, now = Date.now()) {
  const key = crypto.randomBytes(32).toString('base64url');
  const start = Math.min(now, Math.max(now - MAX_AGE_MS, +sessionStart || now));
  const list = live(now);
  list.push({ hash: H(key), ua: String(ua || '').slice(0, 120), createdAt: now, expiresAt: start + MAX_AGE_MS });
  core.writeJsonAtomic(FILE, list.slice(-MAX_KEYS));
  return { key, expiresAt: start + MAX_AGE_MS };
}
function check(key, now = Date.now()) {
  if (typeof key !== 'string' || key.length < 40 || key.length > 64) return null;
  const h = H(key); const r = live(now).find((x) => x.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
  return r ? { expiresAt: r.expiresAt } : null;
}
function revokeAll() { core.writeJsonAtomic(FILE, []); }
module.exports = { issue, check, revokeAll, setBinding, MAX_AGE_MS, FILE };
