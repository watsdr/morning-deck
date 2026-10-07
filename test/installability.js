// Installability check in a normal (non-incognito) Chrome profile via CDP Page.getInstallabilityErrors.
// 127.0.0.1 counts as a secure origin, so this mirrors what Chrome checks over HTTPS.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { chromium } = require('playwright-core');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const BASE = process.argv[2] || `http://127.0.0.1:${env.MD_PORT || 8787}`;
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-profile-'));
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, state: r.active && r.active.state }; });
  await page.reload({ waitUntil: 'networkidle' });
  const cdp = await ctx.newCDPSession(page);
  const inst = await cdp.send('Page.getInstallabilityErrors');
  const man = await cdp.send('Page.getAppManifest');
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  // offline: app shell + last deck should still load from the SW cache
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card[data-id], #cleared:not([hidden])', { timeout: 8000 });
  const offlineOk = await page.evaluate(() => document.querySelectorAll('.card[data-id]').length);
  await ctx.setOffline(false);
  const out = { base: BASE.replace(env.MD_TOKEN, '[token]'), installabilityErrors: inst.installabilityErrors, manifestUrl: man.url, manifestParseErrors: man.errors, serviceWorker: sw, controlledAfterReload: controlled, offlineReloadCards: offlineOk, consoleErrors: errors };
  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
  process.exit(inst.installabilityErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
