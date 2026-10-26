#!/usr/bin/env node
// First-run tour: on fresh data (no md_tour_done in localStorage) the tour appears with a visible .tour-skip,
// and skipping it sets md_tour_done so it doesn't come back. Run via `node test/isolated.js test/tour.js` (never the live port).
// Deliberately does NOT use ./skip-tour.
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE;
if (!BASE || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via: node test/isolated.js test/tour.js'); process.exit(2); }
const results = []; const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, info === undefined ? '' : JSON.stringify(info)); };

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
    check('md_tour_done not set on fresh data', (await page.evaluate(() => localStorage.getItem('md_tour_done'))) !== '1');
    let visible = false;
    try { await page.waitForSelector('.tour-skip', { state: 'visible', timeout: 5000 }); visible = true; } catch (_) {}
    check('tour appears with visible .tour-skip', visible);
    check('tour dialog present', await page.locator('#tourWrap[role="dialog"]').count() === 1);
    if (visible) {
      await page.click('.tour-skip');
      check('skip sets md_tour_done', (await page.evaluate(() => localStorage.getItem('md_tour_done'))) === '1');
      await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1500);
      check('tour does not reappear after skip', !(await page.locator('.tour-skip').isVisible().catch(() => false)));
    }
  } catch (e) { check('no exception', false, e.message); }
  await browser.close();
  const bad = results.filter((r) => !r).length;
  console.log(`tour: ${results.length - bad}/${results.length} passed`); process.exit(bad ? 1 : 0);
})();
