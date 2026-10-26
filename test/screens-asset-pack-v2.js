// Asset pack v2 screenshots (412x915 phone): deck dark/light, drag right/left (edge glow + stamp), cleared (burst + flame), Reduce effects on.
// Usage: node test/isolated.js test/screens-asset-pack-v2.js --port N [--out DIR]   (SAMPLE data in a temp dir; never the live deck)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!BASE || !DATA || !DATA.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(ROOT, 'run', 'screens-asset-pack-v2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: { Authorization: `Bearer ${env.MD_TOKEN}`, 'Content-Type': 'application/json' } })).json();
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York' });
  await ctx.addInitScript(() => { try { localStorage.setItem('md_tour_done', '1'); } catch (_) {} });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  let fails = 0; const check = (ok, m) => { console.log((ok ? 'ok   ' : 'FAIL ') + m); if (!ok) fails++; };
  const shot = async (n) => { const p = path.join(OUT, n); await page.screenshot({ path: p }); console.log(p); };
  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => history.replaceState(null, '', '/')); // keep the token out of the URL bar
  await page.waitForSelector('.card[data-depth="0"][data-id]'); await sleep(1500);
  check(await page.$('.card[data-depth="0"] .card-lit') !== null, 'lit layer on top card');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { localStorage.setItem('md_theme', t); window.MorningDeck.applyTheme(t); }, theme); await sleep(500);
    await shot(`deck-${theme}.png`);
  }
  await page.evaluate(() => { localStorage.setItem('md_theme', 'dark'); window.MorningDeck.applyTheme('dark'); }); await sleep(300);
  const before = JSON.stringify(await api('/api/answers?all=1')).length;
  const box = await page.locator('.card[data-depth="0"]').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  for (const [name, sx] of [['right', 1], ['left', -1]]) {
    await page.mouse.move(cx, cy); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(cx + sx * i * 13, cy + i); await sleep(16); }
    await sleep(450);
    const st = await page.$eval('.card[data-depth="0"] .card-edge', (e) => ({ dir: e.dataset.dir, op: +getComputedStyle(e).opacity }));
    check(st.dir === name && st.op > 0.3, `edge glow ${name} (dir=${st.dir} opacity=${st.op})`);
    await shot(`drag-${name}.png`);
    await page.mouse.move(cx, cy, { steps: 6 }); await page.mouse.up(); await sleep(700);
  }
  check(JSON.stringify(await api('/api/answers?all=1')).length === before, 'cancelled drags saved nothing');
  // clear via API on temp data, then swipe-free cleared screen; trigger the celebration path directly
  const deck = (await api('/api/deck')).cards;
  for (const c of deck) await api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: c.id, gesture: 'right' }) });
  await page.reload({ waitUntil: 'networkidle' }); await page.evaluate(() => history.replaceState(null, '', '/'));
  await page.waitForSelector('#cleared:not([hidden])');
  await page.evaluate(() => { const b = document.getElementById('fxBurst'); b.hidden = false; b.src = '/assets/v2/confetti-burst.svg?' + Date.now(); });
  await sleep(350); await shot('cleared.png');
  check(await page.$eval('.fx-flame', (i) => i.src.includes('streak-flame-v2') && i.naturalWidth > 0), 'flame v2 loaded');
  // Reduce effects on: back to a deck, glow/stamp still mark direction but squash/burst are off
  await page.evaluate(() => { localStorage.setItem('md_reduce_fx', '1'); });
  await page.reload({ waitUntil: 'networkidle' }); await page.evaluate(() => history.replaceState(null, '', '/')); await sleep(800);
  check(await page.evaluate(() => document.documentElement.classList.contains('reduce-fx')), 'reduce-fx class set');
  check(await page.$eval('#fxBurst', (b) => b.hidden || getComputedStyle(b).display === 'none'), 'burst hidden under Reduce effects');
  await shot('reduce-effects-on.png');
  console.log('page errors:', errs.length ? errs : 'none');
  await browser.close();
  if (fails || errs.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
