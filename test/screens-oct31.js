// Screenshots (isolated): Skipped & snoozed (real data copy, read-only), Notify me opt-in, stay-signed-in recovery; light + dark.
//   MD_SHOTS=/workspace/md-shots MD_REAL_COPY=1 node test/isolated.js test/screens-oct31.js --empty
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright-core');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR, ROOT = path.join(__dirname, '..');
if (!B || !D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const SHOTS = process.env.MD_SHOTS || path.join(ROOT, 'run', 'screens-oct31'); fs.mkdirSync(SHOTS, { recursive: true });
if (process.env.MD_REAL_COPY) for (const f of ['cards.json', 'answers.json']) fs.copyFileSync(path.join(ROOT, 'data', f), path.join(D, f)); // copy only; live files untouched
const TOK = encodeURIComponent((fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, timezoneId: 'America/New_York' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md_tour_done', '1'); localStorage.setItem('md_theme', t); } catch (_) {} }, scheme);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${B}/?token=${TOK}`, { waitUntil: 'load' }); await sleep(2500);
    await page.click('#settingsBtn'); await sleep(500);
    await page.locator('#notifyToggle').scrollIntoViewIfNeeded(); await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, `notify-optin-${scheme}.png`) });
    await page.click('#waitingRowBtn'); await page.waitForSelector('#waitingBody .ins-tiles'); await sleep(600);
    await page.screenshot({ path: path.join(SHOTS, `skipped-snoozed-${scheme}.png`) });
    // stay signed in: drop the cookie, relaunch as the installed app -> straight back to the deck
    await ctx.clearCookies(); await page.goto(`${B}/?source=pwa`, { waitUntil: 'load' }); await sleep(2500);
    assert.strictEqual(await page.locator('.md-lock').count(), 0, 'renewed without a sign-in prompt');
    await page.screenshot({ path: path.join(SHOTS, `stay-signed-in-relaunch-${scheme}.png`) });
    assert.deepStrictEqual(errors, []); await ctx.close();
  }
  await browser.close(); console.log('screens-oct31: ok ->', SHOTS);
})().catch((e) => { console.error(e); process.exit(1); });
