// 2026-10-19 features: replyTo routing fields, History view, Web Push (/api/push/*, /api/notify), reply wording.
// Usage: node test/isolated.js test/features.js   (temp data dir; spawns one extra throwaway server for the push test)
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!BASE || !DATA || !DATA.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
let fails = 0; const ok = (c, m, x) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}${x !== undefined ? ' ' + JSON.stringify(x) : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (base, p, opts = {}, auth = `Bearer ${env.MD_TOKEN}`) => {
  const r = await fetch(base + p, { ...opts, headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const api = (p, o) => call(BASE, p, o);

(async () => {
  // 1. replyTo routing fields survive onto every answer
  const rt = { bot: 'chief-of-staff', agentId: 'agent-1234', ownerBot: 'Chief of Staff', writeBack: { file: '/tmp/x.json' } };
  let r = await api('/api/cards', { method: 'POST', body: JSON.stringify({ id: 'feat-route-1', source: 'Chief of Staff', title: 'Route me', replyTo: rt }) });
  ok(r.status === 201, 'card with replyTo.agentId accepted');
  r = await api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: 'feat-route-1', gesture: 'tap3', text: 'Can you tell me more first?' }) });
  ok(r.status === 201 && JSON.stringify(r.body.answer.replyTo) === JSON.stringify(rt), 'answer carries replyTo.agentId/ownerBot/writeBack unchanged', r.body.answer && r.body.answer.replyTo);
  const a1 = r.body.answer;
  // an answered + undone pair for History
  await api('/api/cards', { method: 'POST', body: JSON.stringify({ id: 'feat-undo-1', source: 'Scheduler', title: 'Undo me', type: 'question' }) });
  await sleep(20);
  r = await api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: 'feat-undo-1', gesture: 'right' }) });
  const undoneId = r.body.answer.id;
  r = await api('/api/answers/undo', { method: 'POST', body: JSON.stringify({ answerId: undoneId }) });
  ok(r.status === 201, 'undo recorded');
  r = await api('/api/answers?all=1');
  ok(r.body.answers.some((a) => a.id === undoneId && a.undone), 'GET /api/answers?all=1 includes the undone answer');

  // 2. /api/notify auth + pending logic (main isolated server)
  r = await call(BASE, '/api/notify', { method: 'POST' }, null);
  ok(r.status === 401, '/api/notify without auth -> 401');
  r = await api('/api/notify?dryRun=1', { method: 'POST' });
  ok(r.status === 200 && r.body.pending > 0 && /^Your Morning Deck is ready: \d+ cards?$/.test(r.body.body), 'dry run builds the message', r.body);
  r = await call(BASE, '/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'http://insecure.example/x', keys: { p256dh: 'a', auth: 'b' } } }) });
  ok(r.status === 400, 'http:// push endpoints rejected');

  // 3. Real Web Push to a local HTTPS endpoint (throwaway server, own data dir; TLS check off ONLY for that process)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-push-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
  const hits = []; let reply = 201;
  const ep = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (req, res) => {
    let n = 0; req.on('data', (d) => (n += d.length)); req.on('end', () => { hits.push({ url: req.url, auth: req.headers.authorization || '', enc: req.headers['content-encoding'], ttl: req.headers.ttl, bytes: n }); res.writeHead(reply); res.end(); });
  });
  await new Promise((res) => ep.listen(0, '127.0.0.1', res));
  const epBase = `https://127.0.0.1:${ep.address().port}`;
  const port = +new URL(BASE).port + 3, PB = `http://127.0.0.1:${port}`;
  const dir = path.join(tmp, 'data'); fs.mkdirSync(dir, { mode: 0o700 });
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, MD_DATA_DIR: dir, MD_PORT: String(port), MD_DIAG_LOG: path.join(tmp, 'diag.log'), NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(PB + '/manifest.webmanifest')).ok) break; } catch {} await sleep(100); }
  try {
    r = await call(PB, '/api/notify', { method: 'POST' });
    ok(r.status === 200 && r.body.pending === 0 && r.body.sent === 0 && r.body.skipped, 'no pending cards -> nothing sent', r.body);
    const p256dh = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth = 'tBHItJI5svbpez7KI4CCXg';
    r = await call(PB, '/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: epBase + '/push/dev1', keys: { p256dh, auth } } }) });
    ok(r.status === 201, 'subscription stored (cookie/Bearer auth)');
    const pf = path.join(dir, 'push.json');
    ok(fs.existsSync(pf) && (fs.statSync(pf).mode & 0o777) === 0o600, 'data/push.json is mode 600');
    r = await call(PB, '/api/push/status');
    ok(r.body.enabled && r.body.subscriptions === 1, 'push status', r.body);
    await call(PB, '/api/cards', { method: 'POST', body: JSON.stringify([{ id: 'p-1', source: 'T', title: 'one' }, { id: 'p-2', source: 'T', title: 'two' }]) });
    r = await call(PB, '/api/notify', { method: 'POST' });
    ok(r.status === 200 && r.body.pending === 2 && r.body.sent === 1 && r.body.body === 'Your Morning Deck is ready: 2 cards', 'notify sends when pending > 0', r.body);
    ok(hits.length === 1 && /^vapid t=/.test(hits[0].auth) && hits[0].enc === 'aes128gcm' && hits[0].bytes > 0, 'push service got an encrypted VAPID request', hits[0] && { ...hits[0], auth: hits[0].auth.slice(0, 8) });
    reply = 410;
    r = await call(PB, '/api/notify', { method: 'POST' });
    ok(r.body.removed === 1 && JSON.parse(fs.readFileSync(pf, 'utf8')).length === 0, 'expired (410) subscription dropped', r.body);
    const cookie = 'md_session=' + require('crypto').createHash('sha256').update('morning-deck-cookie:' + env.MD_TOKEN).digest('base64url');
    r = await call(PB, '/api/notify', { method: 'POST', headers: { Cookie: cookie } }, null);
    ok(r.status === 403, '/api/notify refuses cookie auth (Bearer only)');
    ok(JSON.parse(fs.readFileSync(path.join(dir, 'cards.json'), 'utf8')).every((c) => c.status === 'pending'), 'notify never changes cards');
  } finally { srv.kill('SIGTERM'); ep.close(); }

  // 4. UI: settings (Notify toggle), History (newest first, undone marked, ET times, reply text), reply wording, themes
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  require("./skip-tour")(browser);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"][data-id]');
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsWrap:not([hidden])');
  await sleep(500);
  const nt = await page.evaluate(() => ({ exists: !!document.querySelector('#notifyToggle'), disabled: document.querySelector('#notifyToggle').disabled, hint: document.querySelector('#notifyHint').textContent }));
  ok(nt.exists && !nt.disabled, 'Notify me toggle present and enabled (server has VAPID keys)', nt);
  await page.click('#historyBtn');
  await page.waitForSelector('.hist-row');
  const hist = await page.evaluate(() => [...document.querySelectorAll('.hist-row')].map((r) => ({ id: r.dataset.answer, undone: r.classList.contains('undone'), src: r.querySelector('.hist-src').textContent, title: r.querySelector('.hist-title').textContent, choice: r.querySelector('.hist-choice').textContent, time: r.querySelector('time').textContent, text: (r.querySelector('.hist-text') || {}).textContent || '' })));
  ok(hist[0] && hist[0].id === undoneId && hist[0].undone, 'newest first, undone answer marked', hist[0]);
  const routed = hist.find((x) => x.id === a1.id);
  ok(routed && routed.src === 'Chief of Staff' && routed.title === 'Route me' && routed.text === 'Can you tell me more first?' && / ET$/.test(routed.time), 'row shows bot, title, reply text, ET time', routed);
  const etExpected = new Date(a1.answeredAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  ok(routed && routed.time.includes(etExpected), 'time is America/New_York even on a phone in another zone', { got: routed && routed.time, etExpected });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.evaluate(() => window.MorningDeck.openSheet(window.MorningDeck.state.deck.find((c) => !c.builtin && !(c.rawGestures && c.rawGestures.tap3 && c.rawGestures.tap3.prompt))));
  await sleep(400);
  const lab = await page.evaluate(() => ({ label: document.querySelector('#replyLabel').textContent, ph: document.querySelector('#replyText').placeholder, note: document.querySelector('#sheetNote').textContent }));
  ok(/^Reply or ask .+ a question$/.test(lab.label) && /ask for more info/.test(lab.ph) && /Nothing is sent/.test(lab.note), 'triple-tap sheet says you can ask the bot a question', lab);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.querySelector('[data-theme-opt="light"]').click(); });
  const th = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, stored: localStorage.getItem('md_theme') }));
  ok(th.theme === 'light' && th.stored === 'light', 'light theme applies and persists', th);
  await page.reload({ waitUntil: 'networkidle' });
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'light'), 'light theme survives reload');
  ok(!errs.length, 'no console errors', errs);
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
