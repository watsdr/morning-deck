// Asset pack v1 screenshots (390x844): deck dark/light, mid-drag right, cleared celebration, tour with ghost hand.
// Usage: node test/isolated.js test/screens-asset-pack.js --port N [--out DIR]   (SAMPLE data in a temp dir; never the live deck)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!BASE || !DATA || !DATA.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(ROOT, 'run', 'screens-asset-pack');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: { Authorization: `Bearer ${env.MD_TOKEN}`, 'Content-Type': 'application/json' } })).json();
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York' });
  await ctx.addInitScript(() => { try { localStorage.setItem('md_tour_done', '1'); } catch (_) {} });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  const shot = async (n) => { const p = path.join(OUT, n); await page.screenshot({ path: p }); console.log(p); };
  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"][data-id]'); await sleep(1500);
  const emblems = await page.$$eval('.avatar-emblem img', (a) => a.map((i) => i.naturalWidth > 0));
  console.log('emblems on deck:', emblems.length, 'all loaded:', emblems.every(Boolean));
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { localStorage.setItem('md_theme', t); window.MorningDeck.applyTheme(t); }, theme); await sleep(500);
    await shot(`deck-${theme}.png`);
  }
  await page.evaluate(() => { localStorage.setItem('md_theme', 'dark'); window.MorningDeck.applyTheme('dark'); }); await sleep(300);
  const before = JSON.stringify(await api('/api/answers?all=1')).length;
  const box = await page.locator('.card[data-depth="0"]').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(cx + i * 12, cy + i); await sleep(16); }
  await sleep(250); await shot('drag-right.png');
  await page.mouse.move(cx, cy, { steps: 6 }); await page.mouse.up(); await sleep(700);
  const after = JSON.stringify(await api('/api/answers?all=1')).length;
  console.log('answers before/after cancelled drag:', before, after);
  // tour with ghost hand
  await page.evaluate(() => window.__mdTour.start()); await sleep(1700);
  await shot('tour-ghost-hand.png');
  await page.keyboard.press('Escape'); await sleep(400);
  // clear the deck via the API (temp data), then reload to the cleared screen
  const deck = (await api('/api/deck')).cards;
  for (const c of deck) await api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: c.id, gesture: 'right' }) });
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#cleared:not([hidden])'); await sleep(2500);
  console.log('streak visible:', await page.isVisible('#clearedStreak'), await page.textContent('#clearedStreakN'));
  await shot('cleared.png');
  console.log('page errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
