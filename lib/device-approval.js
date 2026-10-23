'use strict';
// Phone-only sign-in by device approval. The phone asks for access and gets a short display code plus a long
// random poll secret that only it holds. The code is approved on the box only (scripts/approve-phone.sh).
// The code by itself grants nothing: only the poll secret's holder gets the session. All state is in memory and
// a restart drops it. At most 3 pending; each expires after 10 minutes. Approved requests are collected once.
const crypto = require('crypto');
const TTL_MS = 10 * 60e3, MAX_PENDING = 3;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const reqs = new Map(); // code -> { secretHash, ua, createdAt, expiresAt, status }
const H = (s) => crypto.createHash('sha256').update('md-device:' + s).digest('hex');
function prune(now = Date.now()) { for (const [c, r] of reqs) if (r.expiresAt <= now || r.status === 'collected') reqs.delete(c); }
const pending = (now = Date.now()) => { prune(now); return [...reqs.values()].filter((r) => r.status === 'pending').length; };
function newCode() { let c; do { c = Array.from(crypto.randomBytes(6), (b) => ALPHA[b % 32]).join(''); } while (reqs.has(c)); return c; }
function create(ua, now = Date.now()) {
  if (pending(now) >= MAX_PENDING) return null;
  const code = newCode(), secret = crypto.randomBytes(32).toString('base64url');
  reqs.set(code, { secretHash: H(secret), ua: String(ua || '-').replace(/[^\x20-\x7e]/g, '?').slice(0, 160), createdAt: now, expiresAt: now + TTL_MS, status: 'pending' });
  return { code, secret, expiresAt: now + TTL_MS };
}
const norm = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function info(code, now = Date.now()) { prune(now); const r = reqs.get(norm(code)); return r && r.status === 'pending' ? { code: norm(code), ua: r.ua, createdAt: r.createdAt, expiresAt: r.expiresAt } : null; }
function approve(code, now = Date.now()) { prune(now); const r = reqs.get(norm(code)); if (!r || r.status !== 'pending') return null; r.status = 'approved'; return { code: norm(code), ua: r.ua }; }
// Phone polling: 'pending' | 'approved' (returned once, then the request is gone) | 'gone' (expired/unknown).
function poll(code, secret, now = Date.now()) {
  prune(now);
  const r = reqs.get(norm(code));
  if (!r || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return 'gone';
  const a = Buffer.from(H(secret)), b = Buffer.from(r.secretHash);
  if (!crypto.timingSafeEqual(a, b)) return 'gone';
  if (r.status === 'approved') { r.status = 'collected'; reqs.delete(norm(code)); return 'approved'; }
  return 'pending';
}
module.exports = { TTL_MS, MAX_PENDING, create, info, approve, poll, pending, _reqs: reqs };
