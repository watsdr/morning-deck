// E2E (isolated): phone-only sign-in by device approval.
//   node test/isolated.js test/device-approval.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const tok = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const port = new URL(B).port;
const approve = (code, ...a) => spawnSync('bash', ['scripts/approve-phone.sh', code, ...a], { cwd: ROOT, env: { ...process.env, MD_PORT_OVERRIDE: port }, encoding: 'utf8', input: '' });
const post = (p, body, headers = {}) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // 1) real browser flow
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) TestPhone' , serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const r0 = await page.goto(B + '/', { waitUntil: 'networkidle' }); assert.strictEqual(r0.status(), 401);
  await page.click('#mdDevBtn'); await page.waitForSelector('#mdDevCode');
  const code = (await page.textContent('#mdDevCode')).trim();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  fs.mkdirSync(path.join(ROOT, 'run', 'screens-batch2'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'run', 'screens-batch2', 'device-request.png') });
  // approve without --yes and no "y" -> refused
  const no = approve(code); assert.notStrictEqual(no.status, 0); assert.match(no.stdout, /TestPhone/);
  // through a proxy (Funnel adds X-Forwarded-For) the approval API does not exist
  assert.strictEqual((await post('/api/device/approve', { code }, { Authorization: `Bearer ${tok}`, 'X-Forwarded-For': '1.2.3.4' })).status, 404);
  // box-local but cookie/no bearer -> refused
  assert.strictEqual((await post('/api/device/approve', { code })).status, 401);
  const ok = approve(code, '--yes'); assert.strictEqual(ok.status, 0, ok.stderr + ok.stdout);
  assert.ok(!(ok.stdout + ok.stderr).includes(tok), 'token never printed');
  await page.waitForURL(B + '/', { timeout: 15000 }); await page.waitForSelector('.card', { timeout: 15000 });
  const ck = (await ctx.cookies()).find((c) => c.name === 'md_session'); assert.ok(ck, 'session cookie set');
  const days = (ck.expires * 1000 - Date.now()) / 864e5; assert.ok(days > 179 && days < 181, 'cookie ~180 days: ' + days);
  assert.strictEqual(approve(code, '--yes').status === 0, false, 'code is single use');
  await browser.close();
  // 2) API rules
  const mk = () => post('/signin/request', {}, { 'User-Agent': 'curl-test' });
  const a = await (await mk()).json(), b = await (await mk()).json(), c = await (await mk()).json();
  assert.ok(a.code && b.code && c.code && a.secret.length === 43);
  const d = await mk(); assert.strictEqual(d.status, 429, 'max 3 pending');
  assert.strictEqual((await (await post('/signin/request/poll', { code: a.code, secret: 'x'.repeat(43) })).json()).status, 'gone', 'wrong secret');
  const p1 = await post('/signin/request/poll', { code: a.code, secret: a.secret }); assert.strictEqual((await p1.json()).status, 'pending'); assert.ok(!p1.headers.get('set-cookie'));
  assert.strictEqual((await post('/signin/request', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.ok(Math.abs(Date.parse(a.expiresAt) - Date.now() - 10 * 60e3) < 5000, '10-minute expiry');
  // expiry (unit level, fake clock)
  const dev = require('../lib/device-approval');
  const t0 = Date.now() + 3600e3; const e = dev.create('u', t0); assert.strictEqual(dev.poll(e.code, e.secret, t0 + 10 * 60e3 + 1), 'gone');
  // 3) logs: code + UA, never the token or a secret
  await sleep(300);
  const log = fs.readFileSync(path.join(D, 'server.log'), 'utf8');
  assert.ok(log.includes(`request ${code} ua="Mozilla/5.0 (Linux; Android 15; Pixel 9) TestPhone"`) && log.includes(`approved ${code}`));
  assert.ok(!log.includes(tok) && !log.includes(a.secret), 'no token / secret in logs');
  console.log('device-approval: ok');
})().catch((e) => { console.error(String(e.stack || e).split(tok).join('[redacted]')); process.exit(1); });
