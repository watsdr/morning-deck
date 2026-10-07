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
  if (url.searchParams.has('token') && safeEq(url.searchParams.get('token'), TOKEN)) return 'query';
  const c = parseCookies(req)[COOKIE];
  if (c && safeEq(c, COOKIE_VALUE)) return 'cookie';
  return null;
}
function isHttps(req) { return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function sessionCookie(req) {
  return `${COOKIE}=${COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isHttps(req) ? '; Secure' : ''}`;
}
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

const LOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#1b1440"><title>Morning Deck — private</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:linear-gradient(160deg,#1b1440,#5b2a86 55%,#f08a5d);color:#fff;text-align:center}div{padding:32px;max-width:320px}h1{font-size:22px;margin:12px 0 6px}p{opacity:.8;line-height:1.5}</style></head>
<body><div><img src="/icons/icon-192.png" width="72" height="72" alt=""><h1>Morning Deck is private</h1><p>Open it with your private link (the one that ends in <code>?token=…</code>). After the first visit this device stays signed in.</p></div></body></html>`;

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/health' && req.method === 'GET') {
    const cards = core.loadCards();
    return json(res, 200, { ok: true, name: 'morning-deck', version: '0.2.0', time: new Date().toISOString(), pending: cards.filter((c) => core.isPending(c)).length, total: cards.length });
  }
  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, { demo: DEMO, greetingName: GREETING_NAME, uploads: !DEMO, maxPhotos: uploads.MAX_PER_ANSWER });
  }
  if (p === '/api/diag' && req.method === 'POST') {
    const b = (await readBody(req, 4096)) || {};
    if (DEMO) return send(res, 204, '', { 'Cache-Control': 'no-store' }); // demo visitors are anonymous; don't log them
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const bool = (v) => (typeof v === 'boolean' ? v : undefined);
    const line = {
      at: new Date().toISOString(), ua: str(b.ua, 400), displayMode: str(b.displayMode, 20), bipFired: bool(b.bipFired),
      swControlled: bool(b.swControlled), standalone: bool(b.standalone), ts: str(b.ts, 40), event: str(b.event, 40), outcome: str(b.outcome, 20),
      installed: bool(b.installed), path: str(b.path, 40), via: str(req.headers['x-forwarded-proto'] ? 'tunnel' : 'direct', 10),
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
  if (p === '/api/deck' && req.method === 'GET') {
    const now = new Date();
    const cards = core.sortDeck(core.loadCards().filter((c) => core.isPending(c, now)));
    const fb = todaysFeedbackCard(now); // built-in feedback card: always dealt last, regardless of priority
    if (fb) cards.push(fb);
    return json(res, 200, { generatedAt: now.toISOString(), count: cards.length, cards: cards.map(cardForClient) });
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

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'bad url'); }
  res.on('finish', () => {
    const safePath = url.pathname + (url.searchParams.has('token') ? '?token=[redacted]' : '');
    console.log(`${new Date().toISOString()} ${req.method} ${safePath} ${res.statusCode} ${Date.now() - started}ms`);
  });
  try {
    if (isPublic(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(req, res, url);
    const how = authed(req, url);
    if (!how) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'unauthorized: send Authorization: Bearer <token>' });
      return send(res, 401, LOCKED_PAGE, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    if (how === 'query' && !url.pathname.startsWith('/api/')) {
      // First visit with ?token=: set the httpOnly cookie, then drop the token from the URL bar/history.
      url.searchParams.delete('token');
      return send(res, 302, 'redirecting', { 'Set-Cookie': sessionCookie(req), Location: url.pathname + (url.search || ''), 'Cache-Control': 'no-store' });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return json(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
  }
});
if (DEMO) { seedDemo(); setInterval(seedDemo, 3600e3).unref(); }
server.listen(PORT, HOST, () => console.log(`Morning Deck${DEMO ? ' DEMO' : ''} listening on http://${HOST}:${PORT} (data: ${core.DATA_DIR})`));
