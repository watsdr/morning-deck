'use strict';
// Morning Deck server — plain Node http, zero runtime deps.
// SAFETY: this server only records decisions to local JSON files. It never sends
// messages, purchases, submits forms, or calls any outside service.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./lib/core');
const uploads = require('./lib/uploads');
const push = require('./lib/push');
const insights = require('./lib/insights');
const pairing = require('./lib/pairing');
const recap = require('./lib/recap');
const device = require('./lib/device-approval');
let QRCode = null; try { QRCode = require('qrcode'); } catch (_) { /* QR pairing disabled */ }

// ---------- config (.env) ----------
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (_) { /* no .env */ }
}
const ENV_FILE = path.resolve(process.env.MD_ENV_FILE || path.join(core.ROOT, '.env'));
loadEnv(ENV_FILE);
const TOKEN = process.env.MD_TOKEN || '';
const PORT = +(process.env.MD_PORT || 8787);
const HOST = process.env.MD_HOST || '127.0.0.1';
const GREETING_NAME = (process.env.MD_GREETING_NAME || '').trim().slice(0, 40); // "" -> just "Good morning"
// Demo mode (MD_DEMO=1): public, no token; answers are NOT stored (every visitor gets a fresh deck); no uploads,
// no card intake; the SAMPLE deck is re-seeded at start and hourly. Must use its own data dir and env file.
const DEMO = process.env.MD_DEMO === '1';
if (TOKEN.length < 32) { console.error('MD_TOKEN missing/too short in .env — run scripts/init-env.sh'); process.exit(1); }
if (DEMO && (core.DATA_DIR === path.join(core.ROOT, 'data') || ENV_FILE === path.join(core.ROOT, '.env'))) {
  console.error('MD_DEMO=1 refuses to use the real data dir or .env: set MD_DATA_DIR and MD_ENV_FILE to demo-only paths (see scripts/demo.sh)');
  process.exit(1);
}
function seedDemo() {
  const sampleCards = require('./scripts/sample-cards');
  const now = new Date();
  const cards = sampleCards(now).map((raw) => ({ ...core.validateCard(raw, now).card, status: 'pending', receivedAt: now.toISOString() }));
  core.withLock(() => { core.saveCards(cards); core.saveAnswers([]); core.saveBuiltin([]); })
    .then(() => console.log(`${now.toISOString()} demo: seeded ${cards.length} sample cards in ${core.DATA_DIR}`));
}
const PUBLIC = path.join(core.ROOT, 'public');
// Install diagnostics from the phone (POST /api/diag): one JSON line per beacon, UA + display/SW flags only.
const DIAG_LOG = process.env.MD_DIAG_LOG || path.join(core.ROOT, 'logs', 'diag.log');
const DIAG_MAX_BYTES = 2 * 1024 * 1024;
// Android app (TWA) support: Digital Asset Links (public, so Chrome can verify the app and hide the URL bar)
// and the personal APK download (behind auth; since 2026-10-19 it carries no token, but it is still personal: never publish).
const ASSETLINKS_FILE = process.env.MD_ASSETLINKS_FILE || path.join(core.ROOT, 'run', 'android', 'assetlinks.json');
const APK_FILE = process.env.MD_APK_FILE || path.join(core.ROOT, '..', 'morning-deck-android', 'MorningDeck.apk');
const COOKIE = 'md_session';
const COOKIE_VALUE = crypto.createHash('sha256').update('morning-deck-cookie:' + TOKEN).digest('base64url');

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
// Public files carry no data: Chrome fetches the manifest and icons without credentials.
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/sw.js', '/favicon.ico', '/robots.txt']);
const isPublic = (p) => PUBLIC_PATHS.has(p) || p.startsWith('/icons/');

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authed(req, url) {
  if (DEMO) return 'demo';
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && safeEq(h.slice(7).trim(), TOKEN)) return 'bearer';
  // ?token= is only for the one-time sign-in link on pages; the API takes the Bearer header (or the cookie) only.
  if (url.searchParams.has('token') && !url.pathname.startsWith('/api/') && safeEq(url.searchParams.get('token'), TOKEN)) return 'query';
  const c = parseCookies(req)[COOKIE];
  if (c && safeEq(c, COOKIE_VALUE)) return 'cookie';
  return null;
}
// Always Secure (browsers treat http://127.0.0.1 and localhost as secure contexts, so local use still works) and
// SameSite=Strict. See CROSS_SITE_BOUNCE below for how links from other apps still open the deck.
function sessionCookie(maxAge = 31536000) {
  return `${COOKIE}=${COOKIE_VALUE}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
const PAIR_COOKIE_AGE = 180 * 86400; // QR-paired phones: ~180 days
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}
const json = (res, status, obj, headers = {}) => send(res, status, obj, { 'Cache-Control': 'no-store', ...headers });
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const len = +req.headers['content-length'];
    if (len > limit) { req.resume(); return reject(Object.assign(new Error(`upload too large (max ${Math.round(limit / 1048576)} MB)`), { status: 413 })); }
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error(`upload too large (max ${Math.round(limit / 1048576)} MB)`), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function cardForClient(c) {
  return { ...c, gestures: core.effectiveGestures(c), rawGestures: c.gestures || undefined };
}
// Load a card for read-modify-write (call inside core.withLock). Bot cards live in cards.json; the built-in daily
// feedback card is generated from code and only its state (answered/snoozed) is persisted, in builtin.json.
function openCard(id, now = new Date()) {
  const fm = core.FEEDBACK_RE.exec(id);
  if (fm) {
    if (fm[1] > core.etDate(now)) return null; // no answering tomorrow's card
    const st = core.loadBuiltin().find((s) => s.id === id);
    if (!st && fm[1] !== core.etDate(now) && fm[1] !== core.etDate(new Date(now - 864e5))) return null;
    const card = { ...core.feedbackCard(fm[1]), status: 'pending', ...(st || {}) };
    delete card.updatedAt;
    return {
      card, builtin: true,
      save() {
        const keepAfter = now.getTime() - 60 * 864e5; // prune state older than 60 days
        const list = core.loadBuiltin().filter((s) => s.id !== id && Date.parse(s.updatedAt || 0) > keepAfter);
        list.push(core.builtinState(card)); core.saveBuiltin(list);
      },
    };
  }
  const cards = core.loadCards();
  const card = cards.find((c) => c.id === id);
  return card ? { card, builtin: false, save: () => core.saveCards(cards) } : null;
}
function todaysFeedbackCard(now) {
  const o = openCard(core.feedbackId(core.etDate(now)), now);
  return o && core.isPending(o.card, now) ? o.card : null;
}

// Sign-in / "Sign in again" page, served (401, no-store, X-MD-Lock) for any unauthenticated page load. Self-contained:
// inline CSS (no FOUC), theme picked before paint from md_theme / prefers-color-scheme. The form POSTs to /signin.
const LOCK_CSS = `:root{color-scheme:dark;--bg:linear-gradient(160deg,#1b1440,#5b2a86 55%,#f08a5d);--fg:#fff;--sub:rgba(255,255,255,.8);--box:rgba(255,255,255,.12);--line:rgba(255,255,255,.35);--btn:#fff;--btnfg:#1b1440;--err:#ffb3c0;--note:rgba(255,170,31,.22)}
html[data-theme=light]{color-scheme:light;--bg:linear-gradient(180deg,#e9e3ff,#f3e6f7 45%,#fde3e4 75%,#ffd9c4);--fg:#1d1832;--sub:#4b4566;--box:rgba(255,255,255,.75);--line:rgba(29,24,50,.25);--btn:#1d1832;--btnfg:#fff;--err:#b0002a;--note:rgba(255,170,31,.3)}
.md-lock{position:fixed;inset:0;z-index:2147483000;overflow:auto;display:grid;place-items:center;margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);text-align:center}
.md-lock.over{background:rgba(10,6,30,.72);backdrop-filter:blur(6px)}html[data-theme=light] .md-lock.over{background:rgba(246,233,242,.82)}
.md-lock .in{padding:28px 24px;max-width:340px;width:100%;box-sizing:border-box}.md-lock h1{font-size:22px;margin:12px 0 6px}.md-lock p{color:var(--sub);line-height:1.5;margin:8px 0;font-size:15px}
.md-lock .note{background:var(--note);color:var(--fg);border-radius:10px;padding:8px 10px;font-size:14px}
.md-lock form{display:grid;gap:10px;margin:16px 0 8px}.md-lock textarea{font:inherit;font-size:16px;min-height:64px;resize:vertical;border-radius:12px;border:1px solid var(--line);background:var(--box);color:var(--fg);padding:10px 12px;box-sizing:border-box;width:100%}
.md-lock button{font:inherit;font-weight:600;font-size:16px;border:0;border-radius:12px;padding:12px;background:var(--btn);color:var(--btnfg);cursor:pointer}.md-lock button:disabled{opacity:.6}
.md-lock .err{color:var(--err);min-height:1.4em;font-size:14px}.md-lock small{color:var(--sub);font-size:13px;line-height:1.45;display:block}`;
// Form logic, inline on the page; app.js runs the same markup/script when an /api call 401s (it GETs /signin).
const LOCK_SCRIPT = `(function(){var d=document.getElementById('mdDevBtn');if(!d)return;var w=document.getElementById('mdDev'),de=document.getElementById('mdDevErr');
d.addEventListener('click',function(){d.disabled=true;de.textContent='';fetch('/signin/request',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
if(!r.ok){d.disabled=false;de.textContent=r.status===429?(j.error||'Too many requests. Try again later.'):(j.error||'Could not start a request.');return}
var until=Date.parse(j.expiresAt);w.innerHTML='<p>Approve this code on the box:</p><p id="mdDevCode" style="font:700 34px/1.2 ui-monospace,monospace;letter-spacing:.18em;margin:6px 0;color:var(--fg)"></p><small id="mdDevWait">Waiting for approval…</small>';
document.getElementById('mdDevCode').textContent=j.code;var wt=document.getElementById('mdDevWait');
(function tick(){if(Date.now()>until){wt.textContent='This request expired. Reload to try again.';return}
fetch('/signin/request/poll',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:j.code,secret:j.secret})}).then(function(r){return r.json().catch(function(){return{}})}).then(function(p){
if(p.status==='approved'){wt.textContent='Approved. Opening your deck…';location.replace('/');return}if(p.status==='gone'){wt.textContent='This request expired or was refused. Reload to try again.';return}
var m=Math.max(0,Math.ceil((until-Date.now())/60000));wt.textContent='Waiting for approval… ('+m+' min left)';setTimeout(tick,3000)}).catch(function(){setTimeout(tick,5000)})})()})}).catch(function(){d.disabled=false;de.textContent='Offline? Could not reach Morning Deck.'})})})();
(function(){var f=document.getElementById('mdSignin');if(!f)return;var t=f.querySelector('textarea'),b=f.querySelector('button'),e=document.getElementById('mdSigninErr');
f.addEventListener('submit',function(ev){ev.preventDefault();var v=t.value.trim();if(!v){e.textContent='Paste your token or sign-in link.';return}b.disabled=true;e.textContent='';
fetch('/signin',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:v})}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
if(r.ok){t.value='';location.replace('/');return}b.disabled=false;e.textContent=r.status===429?('Too many attempts. Try again in '+Math.ceil((j.retryAfter||60)/60)+' min.'):(j.error||'That token didn\\u2019t work.')})}).catch(function(){b.disabled=false;e.textContent='Offline? Could not reach Morning Deck.'})})})();`;
function lockHtml(stale) {
  return `<div class="md-lock" role="dialog" aria-modal="true" aria-labelledby="mdLockH"><div class="in"><img src="/icons/icon-192.png" width="72" height="72" alt=""><h1 id="mdLockH">Sign in again</h1>
${stale ? '<p class="note" id="mdStale">This link is out of date. Paste your current token or sign-in link below.</p>' : '<p>Morning Deck is private and this device isn\u2019t signed in (or its session expired).</p>'}
<form id="mdSignin" autocomplete="off"><textarea name="token" aria-label="Token or sign-in link" placeholder="Paste your token or sign-in link" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea><div class="err" id="mdSigninErr" role="alert"></div><button type="submit">Sign in</button></form>
<div id="mdDev"><button type="button" id="mdDevBtn">Request access from this phone</button><div class="err" id="mdDevErr" role="alert"></div></div>
<small>Or open your private sign-in link (the one ending in <code>?token=…</code>) on this device.</small></div></div>`;
}
const THEME_BOOT = `<script>try{var m=localStorage.getItem("md_theme");if(m==="light"||(!m&&matchMedia("(prefers-color-scheme: light)").matches))document.documentElement.dataset.theme="light"}catch(e){}</script>`;
const lockPage = (stale) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#1b1440"><meta name="color-scheme" content="dark light"><title>Morning Deck — sign in</title>${THEME_BOOT}<style>${LOCK_CSS}</style></head>
<body>${lockHtml(stale)}<script>${LOCK_SCRIPT}</script></body></html>`;
const LOCKED_PAGE = lockPage(false);

// Failed sign-in rate limit: per client (X-Forwarded-For from the Funnel, else socket) and a global cap, 15-min window.
const SIGNIN_WINDOW = 15 * 60e3, SIGNIN_PER_CLIENT = 5, SIGNIN_GLOBAL = 30;
const signinFails = new Map(); let signinGlobal = [];
function signinKey(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'; }
function signinBlocked(key, now = Date.now()) {
  signinGlobal = signinGlobal.filter((t) => now - t < SIGNIN_WINDOW);
  const mine = (signinFails.get(key) || []).filter((t) => now - t < SIGNIN_WINDOW); signinFails.set(key, mine);
  const list = mine.length >= SIGNIN_PER_CLIENT ? mine : signinGlobal.length >= SIGNIN_GLOBAL ? signinGlobal : null;
  return list ? Math.ceil((list[0] + SIGNIN_WINDOW - now) / 1000) : 0;
}
async function handleSignin(req, res) {
  if (DEMO) return json(res, 404, { error: 'not found' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'cross-site sign-in refused' });
  const key = signinKey(req); const wait = signinBlocked(key);
  if (wait) return json(res, 429, { error: 'too many failed attempts', retryAfter: wait }, { 'Retry-After': String(wait) });
  let raw = ''; try { const b = (await readBody(req, 4096)) || {}; raw = String(b.token || '').trim(); } catch (e) { return json(res, e.status || 400, { error: 'send JSON {"token": "..."}' }); }
  // Accept a bare token or a whole sign-in link (…?token=…).
  if (/[?&]token=/.test(raw)) { try { raw = new URL(raw, 'http://x').searchParams.get('token') || ''; } catch { raw = ''; } }
  if (raw && safeEq(raw, TOKEN)) { signinFails.delete(key); return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie() }); }
  const now = Date.now(); signinFails.get(key).push(now); signinGlobal.push(now);
  return json(res, 401, { error: 'That token didn\u2019t work. It may have been rotated.' });
}

// ---------- phone-only sign-in: device approval (lib/device-approval.js) ----------
const DEVREQ_WINDOW = 15 * 60e3, DEVREQ_PER_CLIENT = 6; const devReqHits = new Map();
async function handleDeviceRequest(req, res) {
  if (DEMO) return json(res, 404, { error: 'not found' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'cross-site request refused' });
  const key = signinKey(req), now = Date.now();
  const mine = (devReqHits.get(key) || []).filter((t) => now - t < DEVREQ_WINDOW); devReqHits.set(key, mine);
  if (mine.length >= DEVREQ_PER_CLIENT) { const wait = Math.ceil((mine[0] + DEVREQ_WINDOW - now) / 1000); return json(res, 429, { error: 'Too many requests from this device. Try again later.', retryAfter: wait }, { 'Retry-After': String(wait) }); }
  const ua = req.headers['user-agent'];
  const r = device.create(ua, now);
  if (!r) return json(res, 429, { error: `Too many pending requests (max ${device.MAX_PENDING}). Wait for one to expire (10 min).`, retryAfter: 60 }, { 'Retry-After': '60' });
  mine.push(now);
  console.log(`${new Date().toISOString()} device-approval: request ${r.code} ua="${device.info(r.code).ua}"`);
  return json(res, 200, { code: r.code, secret: r.secret, expiresAt: new Date(r.expiresAt).toISOString(), pollEveryMs: 3000 }, { 'Cache-Control': 'no-store' });
}
async function handleDevicePoll(req, res) {
  if (DEMO) return json(res, 404, { error: 'not found' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'cross-site request refused' });
  let b = {}; try { b = (await readBody(req, 1024)) || {}; } catch (e) { return json(res, 400, { error: 'send JSON {"code","secret"}' }); }
  const st = device.poll(b.code, b.secret);
  if (st === 'approved') return json(res, 200, { status: 'approved' }, { 'Set-Cookie': sessionCookie(PAIR_COOKIE_AGE), 'Cache-Control': 'no-store' });
  return json(res, 200, { status: st }, { 'Cache-Control': 'no-store' });
}

// ---------- QR pairing ----------
// The QR page and QR image are box-only: loopback socket, loopback Host header, no proxy/forwarding headers (the
// Tailscale Funnel also connects from 127.0.0.1 but always adds X-Forwarded-For and the public Host), AND normal auth.
const PUBLIC_URL = (process.env.MD_PUBLIC_URL || (() => { try { return fs.readFileSync(path.join(core.ROOT, 'run', 'tailscale.url'), 'utf8').trim(); } catch { return ''; } })() || 'https://morning-deck.tail164b96.ts.net').replace(/\/+$/, '');
function isBoxLocal(req) {
  const ra = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) return false;
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'tailscale-funnel-request', 'cf-connecting-ip'])
    if (req.headers[h] !== undefined) return false;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}
// The code travels in the URL fragment (#...), so it never reaches any server log or proxy; the /pair page POSTs it.
const pairUrl = (code) => `${PUBLIC_URL}/pair#${code}`;
const PAIR_WINDOW = 15 * 60e3, PAIR_PER_CLIENT = 10, PAIR_GLOBAL = 40;
const pairHits = new Map(); let pairGlobal = [];
function pairBlocked(key, now = Date.now()) {
  pairGlobal = pairGlobal.filter((t) => now - t < PAIR_WINDOW);
  const mine = (pairHits.get(key) || []).filter((t) => now - t < PAIR_WINDOW); pairHits.set(key, mine);
  const list = mine.length >= PAIR_PER_CLIENT ? mine : pairGlobal.length >= PAIR_GLOBAL ? pairGlobal : null;
  return list ? Math.ceil((list[0] + PAIR_WINDOW - now) / 1000) : 0;
}
const PAIR_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Morning Deck — pairing</title>${THEME_BOOT}<style>${LOCK_CSS}</style></head>
<body><div class="md-lock"><div class="in"><img src="/icons/icon-192.png" width="72" height="72" alt=""><h1>Pairing this phone…</h1><p id="msg">One moment.</p></div></div>
<script>(function(){var c=location.hash.slice(1);try{history.replaceState(null,'',location.pathname)}catch(e){}var m=document.getElementById('msg');
if(!c){m.textContent='This pairing link is incomplete. Scan the QR code again.';return}
fetch('/pair',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
if(r.ok){m.textContent='Paired. Opening your deck…';location.replace('/');return}
m.textContent=r.status===429?'Too many attempts. Try again in '+Math.ceil((j.retryAfter||60)/60)+' min.':(j.error||'That code did not work.')})}).catch(function(){m.textContent='Could not reach Morning Deck.'})})();</script></body></html>`;
async function handlePair(req, res) {
  if (DEMO) return json(res, 404, { error: 'not found' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'cross-site pairing refused' });
  const key = signinKey(req); const wait = pairBlocked(key);
  if (wait) return json(res, 429, { error: 'too many pairing attempts', retryAfter: wait }, { 'Retry-After': String(wait) });
  const now = Date.now(); pairHits.get(key).push(now); pairGlobal.push(now); // every attempt counts, success or not
  let code = ''; try { code = String(((await readBody(req, 1024)) || {}).code || ''); } catch (e) { return json(res, 400, { error: 'send JSON {"code": "..."}' }); }
  if (!pairing.redeem(code)) return json(res, 401, { error: 'This pairing code is invalid, used, or expired (codes last 5 minutes). Make a new one on the box.' });
  console.log(`${new Date().toISOString()} pairing: a device was paired via QR (180-day session)`);
  return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(PAIR_COOKIE_AGE) });
}
async function qrPage(res) {
  const { code, expiresAt } = pairing.create();
  const svg = await QRCode.toString(pairUrl(code), { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Morning Deck — pair a phone</title>${THEME_BOOT}<style>${LOCK_CSS}
.qr{background:#fff;border-radius:16px;padding:10px;width:240px;height:240px;margin:14px auto}.qr svg{width:100%;height:100%}</style></head>
<body><div class="md-lock"><div class="in"><h1>Pair a phone</h1><p>Scan with the phone's camera. The code works once and expires in <b id="left">5:00</b>.</p>
<div class="qr" id="qr" aria-label="Pairing QR code">${svg}</div><p class="note" id="exp" hidden>Expired.</p>
<button type="button" onclick="location.reload()">New code</button><small style="margin-top:12px">Box-only page. The phone gets a 180-day session; the code is then burned.</small></div></div>
<script>(function(){var end=${expiresAt},l=document.getElementById('left');function t(){var s=Math.max(0,Math.round((end-Date.now())/1000));l.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');if(!s){document.getElementById('qr').style.opacity=.15;document.getElementById('exp').hidden=false;return}setTimeout(t,1000)}t()})();</script></body></html>`;
  return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

const CROSS_SITE_BOUNCE = '<script>location.replace(location.href)</script>';

// ---------- API ----------
async function handleApi(req, res, url, how) {
  const p = url.pathname;
  if (p === '/api/health' && req.method === 'GET') {
    const cards = core.loadCards();
    return json(res, 200, { ok: true, name: 'morning-deck', version: '0.2.0', time: new Date().toISOString(), pending: cards.filter((c) => core.isPending(c)).length, total: cards.length });
  }
  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, { demo: DEMO, greetingName: GREETING_NAME, uploads: !DEMO, maxPhotos: uploads.MAX_PER_ANSWER, push: !DEMO && push.enabled() });
  }
  // ---------- Web Push ("Notify me") ----------
  if (p === '/api/push/key' && req.method === 'GET') {
    if (DEMO || !push.enabled()) return json(res, 200, { enabled: false });
    return json(res, 200, { enabled: true, publicKey: push.publicKey() });
  }
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    if (DEMO) return json(res, 403, { error: 'notifications are disabled in the demo' });
    if (!push.enabled()) return json(res, 503, { error: 'push is not configured (scripts/init-vapid.sh)' });
    const b = (await readBody(req, 8192)) || {};
    const sub = await core.withLock(() => push.subscribe(b.subscription || b, req.headers['user-agent']));
    if (!sub) return json(res, 400, { error: 'subscription must be {endpoint: https URL, keys: {p256dh, auth}}' });
    return json(res, 201, { ok: true, subscribed: true });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    if (DEMO) return json(res, 403, { error: 'notifications are disabled in the demo' });
    const b = (await readBody(req, 8192)) || {};
    const removed = await core.withLock(() => push.unsubscribe(String(b.endpoint || '')));
    return json(res, 200, { ok: true, removed });
  }
  if (p === '/api/push/status' && req.method === 'GET') {
    return json(res, 200, { enabled: !DEMO && push.enabled(), subscriptions: DEMO ? 0 : push.load().length });
  }
  // POST /api/notify (Bearer only): "Your Morning Deck is ready: N cards" to every subscribed device, only if N > 0.
  if (p === '/api/notify' && req.method === 'POST') {
    if (how !== 'bearer') return json(res, 403, { error: 'POST /api/notify needs Authorization: Bearer <token>' });
    if (DEMO) return json(res, 403, { error: 'notifications are disabled in the demo' });
    const pending = core.loadCards().filter((c) => core.isPending(c)).length;
    if (!pending) return json(res, 200, { pending, sent: 0, skipped: 'nothing pending' });
    if (!push.enabled()) return json(res, 503, { pending, sent: 0, error: 'push is not configured (scripts/init-vapid.sh)' });
    const body = `Your Morning Deck is ready: ${pending} card${pending === 1 ? '' : 's'}`;
    if (url.searchParams.get('dryRun') === '1') return json(res, 200, { pending, sent: 0, dryRun: true, body, subscriptions: push.load().length });
    const r = await push.sendAll({ title: 'Morning Deck', body, url: '/', tag: 'morning-deck-ready', pending });
    return json(res, 200, { pending, body, ...r });
  }
  if (p === '/api/diag' && req.method === 'POST') {
    const b = (await readBody(req, 4096)) || {};
    if (DEMO) return send(res, 204, '', { 'Cache-Control': 'no-store' }); // demo visitors are anonymous; don't log them
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const bool = (v) => (typeof v === 'boolean' ? v : undefined);
    const line = {
      at: new Date().toISOString(), ua: str(b.ua, 400), displayMode: str(b.displayMode, 20), bipFired: bool(b.bipFired),
      swControlled: bool(b.swControlled), standalone: bool(b.standalone), ts: str(b.ts, 40), event: str(b.event, 40), outcome: str(b.outcome, 20),
      installed: bool(b.installed), bipSupported: bool(b.bipSupported), secs: typeof b.secs === 'number' ? Math.round(b.secs) : undefined, path: str(b.path, 40), via: str(req.headers['x-forwarded-proto'] ? 'tunnel' : 'direct', 10),
    };
    try {
      fs.mkdirSync(path.dirname(DIAG_LOG), { recursive: true });
      let size = 0; try { size = fs.statSync(DIAG_LOG).size; } catch {}
      if (size < DIAG_MAX_BYTES) fs.appendFileSync(DIAG_LOG, JSON.stringify(line) + '\n');
    } catch (e) { console.warn('diag log write failed:', e.message); }
    return send(res, 204, '', { 'Cache-Control': 'no-store' });
  }
  if (DEMO) {
    // Demo: nothing a visitor does is persisted or shared with other visitors.
    if (p === '/api/cards' && req.method === 'POST') return json(res, 403, { error: 'card intake is disabled in the demo' });
    if (p.startsWith('/api/uploads')) return json(res, req.method === 'POST' ? 403 : 404, { error: 'photos are disabled in the demo' });
    if (p === '/api/answers' && req.method === 'GET') return json(res, 200, { count: 0, answers: [], demo: true });
    if (p === '/api/answers/undo' && req.method === 'POST') return json(res, 201, { undo: { gesture: 'undo', demo: true }, card: null });
  }
  { // Read-only zone feeds written by other bots (e.g. Scheduler for Lantern Isle). Auth-gated like every /api route.
    const m = p.match(/^\/api\/zones\/([a-z0-9-]{1,40})$/);
    if (m && req.method === 'GET') {
      if (DEMO) return json(res, 404, { error: 'no zones in the demo' });
      const f = path.join(core.DATA_DIR, 'zones', m[1] + '.json');
      let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { return json(res, 404, { error: 'zone not published yet' }); }
      try { return send(res, 200, JSON.stringify(JSON.parse(raw)), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); }
      catch { return json(res, 502, { error: 'zone file is not valid JSON' }); }
    }
  }
  if (p === '/api/deck' && req.method === 'GET') {
    const now = new Date();
    const cards = core.sortDeck(core.loadCards().filter((c) => core.isPending(c, now)));
    const fb = todaysFeedbackCard(now); // built-in feedback card: always dealt last, regardless of priority
    if (fb) cards.push(fb);
    return json(res, 200, { generatedAt: now.toISOString(), count: cards.length, cards: cards.map(cardForClient) });
  }
  // Read-only at-a-glance stats (same auth as /api/deck: cookie or Bearer). Never writes.
  if (p === '/api/insights' && req.method === 'GET') {
    if (DEMO) return json(res, 200, { demo: true, ...insights.compute({ answers: [] }) });
    return json(res, 200, insights.compute());
  }
  // Weekly recap (computed on the fly from answers + insights; read-only, never a card).
  if (p === '/api/recap' && req.method === 'GET') {
    if (DEMO) return json(res, 200, { demo: true, ...recap.compute({ answers: [], withBackups: false }) });
    return json(res, 200, recap.compute());
  }
  if (p === '/api/cards' && req.method === 'GET') {
    return json(res, 200, { cards: core.loadCards().map(cardForClient) });
  }
  if (p === '/api/cards' && req.method === 'POST') {
    const body = await readBody(req);
    const list = Array.isArray(body) ? body : body && Array.isArray(body.cards) ? body.cards : [body];
    if (!list.length || list.length > 500) return json(res, 400, { error: 'send 1-500 cards' });
    const now = new Date();
    const results = list.map((c, i) => ({ i, ...core.validateCard(c, now) }));
    const invalid = results.filter((r) => r.errors.length).map((r) => ({ index: r.i, id: list[r.i] && list[r.i].id, errors: r.errors }));
    if (invalid.length) return json(res, 400, { error: 'validation failed', invalid });
    const out = await core.withLock(() => {
      const cards = core.loadCards();
      const ids = new Set(cards.map((c) => c.id));
      const added = [], duplicates = [];
      for (const { card } of results) {
        if (ids.has(card.id)) { duplicates.push(card.id); continue; }
        ids.add(card.id);
        cards.push({ ...card, status: 'pending', receivedAt: now.toISOString() });
        added.push(card.id);
      }
      if (added.length) core.saveCards(cards);
      return { added, duplicates };
    });
    return json(res, out.added.length ? 201 : 200, out);
  }
  if (p === '/api/uploads' && req.method === 'POST') {
    const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let buf, opts = { clientUploadId: req.headers['x-client-upload-id'] || url.searchParams.get('clientUploadId') || undefined, width: req.headers['x-image-width'], height: req.headers['x-image-height'] };
    if (ctype === 'application/json') {
      const b = (await readBody(req, Math.ceil(uploads.MAX_BYTES * 4 / 3) + 64 * 1024)) || {};
      const m = /^data:([^;,]+)?(;base64)?,/.exec(typeof b.data === 'string' ? b.data : '');
      const b64 = typeof b.data === 'string' ? (m ? b.data.slice(m[0].length) : b.data) : '';
      if (!b64) return json(res, 400, { error: 'JSON uploads need {data: "<base64 or data: URL>"}' });
      buf = Buffer.from(b64, 'base64');
      opts = { clientUploadId: b.clientUploadId ?? opts.clientUploadId, width: b.width ?? opts.width, height: b.height ?? opts.height };
    } else {
      if (ctype && !ctype.startsWith('image/') && ctype !== 'application/octet-stream') return json(res, 415, { error: 'send image bytes with Content-Type image/*, or JSON {data: base64}' });
      buf = await readRaw(req, uploads.MAX_BYTES);
    }
    const { meta, duplicate } = uploads.save(buf, opts);
    const d = uploads.describe(meta);
    return json(res, duplicate ? 200 : 201, { ...d, duplicate: duplicate || undefined });
  }
  const um = /^\/api\/uploads\/([^/]+)$/.exec(p);
  if (um && (req.method === 'GET' || req.method === 'HEAD')) {
    const meta = uploads.get(um[1]);
    if (!meta) return json(res, 404, { error: 'unknown upload' });
    const file = uploads.filePath(meta);
    return fs.stat(file, (err, st) => {
      if (err) return json(res, 404, { error: 'upload file missing' });
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': meta.mime, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename="${meta.id}.${meta.ext}"` });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }
  if (p === '/api/answers' && req.method === 'GET') {
    let list = core.loadAnswers();
    const since = url.searchParams.get('since');
    if (since) { const t = Date.parse(since); if (Number.isNaN(t)) return json(res, 400, { error: 'since must be ISO-8601' }); list = list.filter((a) => Date.parse(a.recordedAt) >= t); }
    const source = url.searchParams.get('source');
    if (source) { const s = source.toLowerCase(); list = list.filter((a) => (a.source || '').toLowerCase() === s || (a.sourceId || '').toLowerCase() === s); }
    const cardId = url.searchParams.get('cardId');
    if (cardId) list = list.filter((a) => a.cardId === cardId);
    if (url.searchParams.get('all') !== '1') list = list.filter((a) => a.gesture !== 'undo' && !a.undone);
    return json(res, 200, { count: list.length, answers: list });
  }
  if (p === '/api/answers' && req.method === 'POST') {
    const b = (await readBody(req)) || {};
    if (!b.cardId || typeof b.cardId !== 'string') return json(res, 400, { error: 'cardId required' });
    if (!core.GESTURES.includes(b.gesture)) return json(res, 400, { error: `gesture must be one of ${core.GESTURES.join('|')}` });
    if (b.text !== undefined && (typeof b.text !== 'string' || b.text.length > 5000)) return json(res, 400, { error: 'text must be a string <= 5000 chars' });
    if (b.answeredAt !== undefined && Number.isNaN(Date.parse(b.answeredAt))) return json(res, 400, { error: 'answeredAt must be ISO-8601' });
    // attachments: upload ids (strings or {id}) from POST /api/uploads
    let attachments;
    if (b.attachments !== undefined && b.attachments !== null) {
      if (!Array.isArray(b.attachments) || b.attachments.length > uploads.MAX_PER_ANSWER) return json(res, 400, { error: `attachments must be an array of up to ${uploads.MAX_PER_ANSWER} upload ids` });
      attachments = [];
      for (const a of b.attachments) {
        const id = typeof a === 'string' ? a : a && a.id;
        const meta = uploads.get(id);
        if (!meta) return json(res, 400, { error: `unknown attachment id: ${String(id).slice(0, 40)}` });
        if (!attachments.some((x) => x.id === meta.id)) attachments.push(uploads.describe(meta));
      }
      if (!attachments.length) attachments = undefined;
    }
    if (b.gesture === 'tap3' && !(b.text || '').trim() && !attachments) return json(res, 400, { error: 'tap3 answers need text or attachments' });
    const out = await core.withLock(() => {
      const opened = openCard(b.cardId);
      if (!opened) return { status: 404, body: { error: 'unknown cardId' } };
      const card = opened.card;
      if (b.clientAnswerId) {
        const dup = core.loadAnswers().find((a) => a.clientAnswerId === b.clientAnswerId);
        if (dup) return { status: 200, body: { answer: dup, card: cardForClient(card), duplicate: true } };
      }
      // Built-in cards ignore expiry here so a suggestion queued offline last night still lands.
      if (!core.isPending(card, new Date(), { ignoreExpiry: opened.builtin })) return { status: 409, body: { error: `card is ${card.status}`, card: cardForClient(card) } };
      const g = core.effectiveGestures(card)[b.gesture];
      const now = new Date();
      const answer = {
        id: 'ans_' + crypto.randomBytes(6).toString('hex'),
        cardId: card.id, source: card.source, sourceId: card.sourceId, cardTitle: card.title, cardType: card.type, sample: card.sample,
        gesture: b.gesture, label: g.label, value: b.value !== undefined ? b.value : g.value,
        text: b.text && b.text.trim() ? b.text.trim() : undefined, attachments,
        answeredAt: b.answeredAt ? new Date(b.answeredAt).toISOString() : now.toISOString(),
        recordedAt: now.toISOString(), replyTo: card.replyTo, clientAnswerId: b.clientAnswerId,
        builtin: card.builtin || undefined,
      };
      if (g.snooze) {
        answer.snoozedUntil = core.nextSixAmET(now).toISOString();
        card.status = 'snoozed'; card.snoozedUntil = answer.snoozedUntil; card.snoozeCount = (card.snoozeCount || 0) + 1;
      } else {
        card.status = 'answered'; card.answeredAt = answer.answeredAt; delete card.snoozedUntil;
        // Additive counter for Insights (does not change what the card means): how often it was skipped.
        if (b.gesture === 'down' && !opened.builtin) { card.skipCount = (card.skipCount || 0) + 1; card.lastSkippedAt = answer.answeredAt; }
      }
      card.lastAnswerId = answer.id;
      if (DEMO) return { status: 201, body: { answer: { ...answer, demo: true }, card: cardForClient(card) } }; // not stored
      const answers = core.loadAnswers(); answers.push(answer);
      core.saveAnswers(answers); opened.save();
      return { status: 201, body: { answer, card: cardForClient(card) } };
    });
    return json(res, out.status, out.body);
  }
  if (p === '/api/answers/undo' && req.method === 'POST') {
    const b = (await readBody(req)) || {};
    const out = await core.withLock(() => {
      const answers = core.loadAnswers();
      const target = b.answerId ? answers.find((a) => a.id === b.answerId)
        : [...answers].reverse().find((a) => a.gesture !== 'undo' && !a.undone && (!b.cardId || a.cardId === b.cardId));
      if (!target) return { status: 404, body: { error: 'nothing to undo' } };
      if (target.undone) return { status: 409, body: { error: 'already undone' } };
      const opened = openCard(target.cardId);
      const card = opened && opened.card;
      if (card && card.lastAnswerId !== target.id) return { status: 409, body: { error: 'only the latest answer for a card can be undone' } };
      target.undone = true;
      const now = new Date().toISOString();
      const entry = { id: 'ans_' + crypto.randomBytes(6).toString('hex'), cardId: target.cardId, source: target.source, sourceId: target.sourceId, cardTitle: target.cardTitle, sample: target.sample, gesture: 'undo', undoes: target.id, answeredAt: now, recordedAt: now };
      answers.push(entry);
      if (card && target.gesture === 'down' && card.skipCount) card.skipCount -= 1;
      if (card) { card.status = 'pending'; delete card.snoozedUntil; delete card.answeredAt; delete card.lastAnswerId; }
      core.saveAnswers(answers); if (opened) opened.save();
      return { status: 201, body: { undo: entry, card: card ? cardForClient(card) : null } };
    });
    return json(res, out.status, out.body);
  }
  return json(res, 404, { error: 'not found' });
}

// ---------- static ----------
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size };
    // HTML + SW revalidate every time; the service worker handles offline caching.
    headers['Cache-Control'] = ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=86400';
    if (p === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, { ...SEC_HEADERS, ...headers });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}


// ---------- /main-menu reverse proxy (auth required; path forwarded unchanged) ----------
const MAIN_MENU_HOST = '127.0.0.1', MAIN_MENU_PORT = 8082;
const isMainMenu = (p) => p === '/main-menu' || p.startsWith('/main-menu/');
// Forward headers minus hop-by-hop ones, and never pass Morning Deck's own credentials upstream.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);
function upstreamHeaders(req, keepUpgrade) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'authorization' && k !== 'cookie') h[k] = v;
  const rest = (req.headers.cookie || '').split(';').map((x) => x.trim()).filter((x) => x && !x.startsWith(COOKIE + '='));
  if (rest.length) h.cookie = rest.join('; ');
  h['x-forwarded-host'] = req.headers.host || ''; h['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';
  if (keepUpgrade) { h.connection = 'Upgrade'; h.upgrade = req.headers.upgrade; }
  return h;
}
function proxyMainMenu(req, res) {
  const up = http.request({ host: MAIN_MENU_HOST, port: MAIN_MENU_PORT, method: req.method, path: req.url, headers: upstreamHeaders(req) }, (r) => {
    const h = { ...r.headers }; for (const k of Object.keys(h)) if (HOP.has(k)) delete h[k];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) send(res, 502, 'main-menu upstream unavailable'); else res.destroy(); });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'bad url'); }
  res.on('finish', () => {
    const safePath = url.pathname + (url.searchParams.has('token') ? '?token=[redacted]' : '');
    console.log(`${new Date().toISOString()} ${req.method} ${safePath} ${res.statusCode} ${Date.now() - started}ms`);
  });
  try {
    if (url.pathname === '/.well-known/assetlinks.json' && (req.method === 'GET' || req.method === 'HEAD')) {
      let body = null; if (!DEMO) { try { body = JSON.stringify(JSON.parse(fs.readFileSync(ASSETLINKS_FILE, 'utf8'))); } catch {} }
      if (!body) return json(res, 404, []);
      return send(res, 200, body, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
    }
    if (isPublic(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(req, res, url);
    if (url.pathname === '/signin' && req.method === 'GET') return send(res, 200, lockPage(false), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-MD-Lock': '1' });
    if (url.pathname === '/signin' && req.method === 'POST') return await handleSignin(req, res);
    if (url.pathname === '/pair' && req.method === 'GET' && !DEMO) return send(res, 200, PAIR_PAGE, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (url.pathname === '/pair' && req.method === 'POST') return await handlePair(req, res);
    if (url.pathname === '/signin/request' && req.method === 'POST') return await handleDeviceRequest(req, res);
    if (url.pathname === '/signin/request/poll' && req.method === 'POST') return await handleDevicePoll(req, res);
    if (url.pathname.startsWith('/api/device/') && (DEMO || !isBoxLocal(req))) return send(res, 404, 'not found', { 'Cache-Control': 'no-store' });
    if ((url.pathname === '/signin/qr' || url.pathname === '/api/pair/qr.png') && (DEMO || !isBoxLocal(req) || !QRCode)) return send(res, 404, 'not found', { 'Cache-Control': 'no-store' });
    const how = authed(req, url);
    if (!how) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'unauthorized: send Authorization: Bearer <token>', signin: '/signin' }, { 'X-MD-Lock': '1' });
      // SameSite=Strict withholds the cookie on a navigation that started on another site (a link in chat/email, or the
      // redirect after a cross-site ?token link). Reload once from this page: that navigation is same-origin, so the
      // cookie is sent. The reload arrives as Sec-Fetch-Site: same-origin, so an unsigned-in device just sees the lock.
      const site = String(req.headers['sec-fetch-site'] || '');
      const bounce = (site === 'cross-site' || site === 'same-site') && req.headers['sec-fetch-mode'] === 'navigate' && req.method === 'GET';
      const page = url.searchParams.has('token') ? lockPage(true) : LOCKED_PAGE; // stale ?token= (old APK): "out of date" note
      return send(res, 401, bounce ? page.replace('</body>', `${CROSS_SITE_BOUNCE}</body>`) : page, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-MD-Lock': '1' });
    }
    if (how === 'query' && !url.pathname.startsWith('/api/')) {
      // First visit with ?token=: set the httpOnly cookie, then drop the token from the URL bar/history.
      url.searchParams.delete('token');
      return send(res, 302, 'redirecting', { 'Set-Cookie': sessionCookie(), Location: url.pathname + (url.search || ''), 'Cache-Control': 'no-store' });
    }
    if (url.pathname === '/signin/qr' && req.method === 'GET') return await qrPage(res);
    if (url.pathname === '/api/pair/qr.png' && req.method === 'POST') {
      if (how !== 'bearer') return json(res, 403, { error: 'needs Authorization: Bearer <token>' });
      const { code, expiresAt } = pairing.create();
      const png = await QRCode.toBuffer(pairUrl(code), { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
      return send(res, 200, png, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Pair-Expires': new Date(expiresAt).toISOString() });
    }
    // Box-only (checked above) + Bearer: look up / approve a phone's access request by its 6-character code.
    if ((url.pathname === '/api/device/info' || url.pathname === '/api/device/approve') && req.method === 'POST') {
      if (how !== 'bearer') return json(res, 403, { error: 'needs Authorization: Bearer <token>' });
      let b = {}; try { b = (await readBody(req, 1024)) || {}; } catch (e) { return json(res, 400, { error: 'send JSON {"code"}' }); }
      if (url.pathname === '/api/device/info') { const i = device.info(b.code); return i ? json(res, 200, { ...i, createdAt: new Date(i.createdAt).toISOString(), expiresAt: new Date(i.expiresAt).toISOString() }) : json(res, 404, { error: 'no pending request with that code (expired?)' }); }
      const a = device.approve(b.code);
      if (!a) return json(res, 404, { error: 'no pending request with that code (expired?)' });
      console.log(`${new Date().toISOString()} device-approval: approved ${a.code} ua="${a.ua}" (180-day session)`);
      return json(res, 200, { ok: true, code: a.code, ua: a.ua });
    }
    if (isMainMenu(url.pathname)) return proxyMainMenu(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, how);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (url.pathname === '/download/MorningDeck.apk') {
      let st = null; if (!DEMO) { try { st = fs.statSync(APK_FILE); } catch {} }
      if (!st || !st.isFile()) return send(res, 404, 'not found', { 'Cache-Control': 'no-store' });
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': st.size,
        'Content-Disposition': 'attachment; filename="MorningDeck.apk"', 'Cache-Control': 'private, no-store' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(APK_FILE).pipe(res);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return json(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
  }
});
// WebSocket upgrades for /main-menu only, same cookie/bearer check (no ?token on upgrades); everything else is refused.
server.on('upgrade', (req, sock, head) => {
  let url; try { url = new URL(req.url, 'http://localhost'); } catch { return sock.destroy(); }
  const how = isMainMenu(url.pathname) && authed(req, url);
  if (!how || how === 'query') { sock.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
  const up = http.request({ host: MAIN_MENU_HOST, port: MAIN_MENU_PORT, method: req.method, path: req.url, headers: upstreamHeaders(req, true) });
  up.on('upgrade', (r, us, uhead) => {
    let out = `HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n`;
    for (let i = 0; i < r.rawHeaders.length; i += 2) out += `${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}\r\n`;
    sock.write(out + '\r\n'); if (uhead && uhead.length) sock.write(uhead); if (head && head.length) us.write(head);
    us.pipe(sock).pipe(us); us.on('error', () => sock.destroy()); sock.on('error', () => us.destroy());
  });
  up.on('response', (r) => { sock.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); r.resume(); });
  up.on('error', () => sock.destroy());
  up.end();
});
{ const fixed = core.hardenPermissions(); if (fixed.length) console.log(`${new Date().toISOString()} permissions tightened (dirs 700, data files 600): ${fixed.length} path(s)`); }
if (!DEMO) core.checkQueueWarning();
if (DEMO) { seedDemo(); setInterval(seedDemo, 3600e3).unref(); }
server.listen(PORT, HOST, () => console.log(`Morning Deck${DEMO ? ' DEMO' : ''} listening on http://${HOST}:${PORT} (data: ${core.DATA_DIR})`));
