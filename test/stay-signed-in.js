// E2E (isolated): the installed app stays signed in with its device key after the cookie is gone and after a cache update.
//   node test/isolated.js test/stay-signed-in.js --empty
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright-core');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const tok = (fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const post = (p, body, headers = {}) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
(async () => {
  // API guards
  assert.strictEqual((await post('/api/session/key', {})).status, 401, 'no auth -> 401');
  assert.strictEqual((await post('/api/session/key', {}, { Authorization: `Bearer ${tok}` })).status, 403, 'bearer cannot mint a device key');
  assert.strictEqual((await post('/signin/renew', { key: 'x'.repeat(43) })).status, 401, 'bad key -> 401');
  assert.strictEqual((await post('/signin/renew', { key: 'x'.repeat(43) }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'cross-site refused');
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) TestPhone' });
  const page = await ctx.newPage();
  await page.goto(`${B}/?token=${encodeURIComponent(tok)}`, { waitUntil: 'load' });
  const getKey = () => page.evaluate(() => new Promise((r) => { const o = indexedDB.open('md-auth', 1); o.onupgradeneeded = () => o.result.createObjectStore('kv'); o.onsuccess = () => { const g = o.result.transaction('kv').objectStore('kv').get('devkey'); g.onsuccess = () => r(g.result || null); }; }));
  let key = null; for (let i = 0; i < 40 && !key; i++) { key = await getKey(); if (!key) await page.waitForTimeout(150); }
  assert.ok(key && key.length >= 40, 'device key stored in IndexedDB');
  const stored = JSON.parse(fs.readFileSync(path.join(D, 'device-keys.json'), 'utf8'));
  assert.ok(stored.length === 1 && !JSON.stringify(stored).includes(key), 'only the hash is stored');
  assert.ok(stored[0].expiresAt - Date.now() <= 180 * 86400e3 + 5000, 'capped at 180 days');
  // 1) cookie gone, cached shell (SW) path: app API 401 -> renew -> deck
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
  await ctx.clearCookies();
  await page.goto(`${B}/?source=pwa`, { waitUntil: 'load' }); await page.waitForTimeout(2000);
  assert.strictEqual(await page.locator('.md-lock').count(), 0, 'no sign-in prompt after cookie loss');
  assert.ok((await ctx.cookies()).some((c) => c.name === 'md_session'), 'cookie restored');
  // 2) cache update: drop every SW cache + unregister, cookie gone -> server lock page renews and opens the deck
  await page.evaluate(async () => { for (const k of await caches.keys()) await caches.delete(k); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); sessionStorage.clear(); });
  await ctx.clearCookies();
  const r = await page.goto(`${B}/?source=pwa`, { waitUntil: 'load' }); await page.waitForTimeout(2500);
  assert.strictEqual(r.status(), 401, 'first hit is the lock page');
  assert.strictEqual(await page.locator('.md-lock').count(), 0, 'lock page renewed and reloaded into the deck');
  assert.ok((await ctx.cookies()).some((c) => c.name === 'md_session'));
  // 3) stale-token APK launch URL also recovers
  await ctx.clearCookies(); await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${B}/?token=stale-old-apk-token`, { waitUntil: 'load' }); await page.waitForTimeout(2500);
  assert.ok(!page.url().includes('token='), 'stale token dropped from URL'); assert.strictEqual(await page.locator('.md-lock').count(), 0);
  // 4) revoked/expired key -> honest sign-in screen, key removed, no loop
  fs.writeFileSync(path.join(D, 'device-keys.json'), '[]');
  await ctx.clearCookies(); await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${B}/`, { waitUntil: 'load' }); await page.waitForTimeout(2500);
  assert.strictEqual(await page.locator('#mdSignin').count(), 1, 'falls back to sign-in'); assert.strictEqual(await getKey(), null, 'dead key cleared');
  await browser.close(); console.log('stay-signed-in: ok');
})().catch((e) => { console.error(e); process.exit(1); });
