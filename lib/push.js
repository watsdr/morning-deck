'use strict';
// Web Push for the morning "deck is ready" nudge. Subscriptions live in <data>/push.json (600). VAPID keys come from
// .env (MD_VAPID_PUBLIC / MD_VAPID_PRIVATE / MD_VAPID_SUBJECT; scripts/init-vapid.sh creates them). The only thing ever
// pushed is a count ("Your Morning Deck is ready: N cards"); no card content leaves the box.
const fs = require('fs');
const path = require('path');
const core = require('./core');
const PUSH_FILE = path.join(core.DATA_DIR, 'push.json');
const MAX_SUBS = 20;
let webpush = null;
try { webpush = require('web-push'); } catch (_) { /* not installed: push disabled */ }

const keys = () => ({ publicKey: process.env.MD_VAPID_PUBLIC || '', privateKey: process.env.MD_VAPID_PRIVATE || '', subject: process.env.MD_VAPID_SUBJECT || 'mailto:morning-deck@localhost' });
const enabled = () => !!(webpush && keys().publicKey && keys().privateKey);
function load() { try { const s = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8')); return Array.isArray(s) ? s : []; } catch (_) { return []; } }
const save = (subs) => core.writeJsonAtomic(PUSH_FILE, subs);

function validSub(s) {
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || s.endpoint.length > 2000) return null;
  let u; try { u = new URL(s.endpoint); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  const k = s.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) return null;
  return { endpoint: s.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}
function subscribe(raw, ua) {
  const sub = validSub(raw); if (!sub) return null;
  const now = new Date().toISOString();
  const subs = load().filter((x) => x.endpoint !== sub.endpoint);
  subs.push({ ...sub, ua: typeof ua === 'string' ? ua.slice(0, 200) : undefined, createdAt: now });
  save(subs.slice(-MAX_SUBS));
  return sub;
}
function unsubscribe(endpoint) {
  const subs = load(); const left = subs.filter((x) => x.endpoint !== endpoint);
  if (left.length !== subs.length) save(left);
  return subs.length - left.length;
}
// Send one notification to every stored subscription. Expired ones (404/410) are dropped.
async function sendAll(payload) {
  if (!enabled()) return { sent: 0, failed: 0, removed: 0, error: 'push not configured' };
  const k = keys(); const subs = load();
  let sent = 0, failed = 0; const dead = new Set();
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'normal', vapidDetails: { subject: k.subject, publicKey: k.publicKey, privateKey: k.privateKey } });
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint);
      console.warn(`${new Date().toISOString()} push failed (${e.statusCode || e.code || 'error'}) for ${new URL(s.endpoint).host}`);
    }
  }));
  if (dead.size) save(load().filter((x) => !dead.has(x.endpoint)));
  return { sent, failed, removed: dead.size, subscriptions: subs.length };
}
module.exports = { PUSH_FILE, enabled, publicKey: () => keys().publicKey, load, subscribe, unsubscribe, sendAll };
