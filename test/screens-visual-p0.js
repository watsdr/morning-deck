// Visual P0 screenshots at 390x844 (dark + light): stack at rest, mid-drag right (stamp), mid-drag up. Never releases,
// so nothing is recorded; asserts the answers log is unchanged. Usage: node test/isolated.js test/screens-visual-p0.js [--out DIR]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!BASE || !DATA || !DATA.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(ROOT, 'run', 'screens-visual-p0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, m) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${m}`); if (!ok) fails++; };
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const answers = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'answers.json'), 'utf8')).length; } catch { return 0; } };
  const before = answers();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  require('./skip-tour')(browser);
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'America/New_York' });
    await ctx.addInitScript((t) => localStorage.setItem('md_theme', t), theme);
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card[data-depth="0"][data-id]'); await sleep(1400);
    const shot = async (n) => { const p = path.join(OUT, n); await page.screenshot({ path: p }); console.log(p); };
    const depths = await page.$$eval('.card[data-id]', (n) => n.map((c) => c.dataset.depth));
    check(depths.filter((d) => d === '1' || d === '2').length >= 2, `${theme}: 2 cards visible behind the top card (${depths})`);
    await shot(`stack-rest-${theme}.png`);
    const b = await page.$eval('.card[data-depth="0"]', (n) => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.4, w: r.width, h: r.height }; });
    const drag = async (dx, dy, name, dir) => {
      await page.mouse.move(b.x, b.y); await page.mouse.down();
      for (let i = 1; i <= 12; i++) { await page.mouse.move(b.x + dx * i / 12, b.y + dy * i / 12); await sleep(16); }
      await sleep(250);
      const o = await page.$eval(`.card[data-depth="0"] .stamp-${dir}`, (s) => +getComputedStyle(s).opacity);
      check(o > 0.3, `${theme}: ${dir} stamp visible mid-drag (opacity ${o})`);
      await shot(name);
      // return to centre before releasing: springs back, records nothing
      for (let i = 11; i >= 0; i--) { await page.mouse.move(b.x + dx * i / 12, b.y + dy * i / 12); await sleep(16); }
      await page.mouse.up(); await sleep(1200);
    };
    await drag(b.w * 0.3, 10, `drag-right-${theme}.png`, 'right');
    await drag(0, -b.h * 0.18, `drag-up-${theme}.png`, 'up');
    check(!errs.length, `${theme}: no page errors ${JSON.stringify(errs)}`);
    await ctx.close();
  }
  check(answers() === before, 'drags that return to centre record nothing');
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
