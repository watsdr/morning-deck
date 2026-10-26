// Phone-size (390x844) screenshots of the Insights view.
//   node test/isolated.js test/screens-insights.js --empty          -> FAKE data (dark + light) in a temp dir
//   node test/screens-insights.js --live                            -> real data, read-only, via http://127.0.0.1 only
// Output: run/screens-insights/. Never prints the token; the live run blocks every non-GET request.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const LIVE = process.argv.includes('--live');
const BASE = LIVE ? `http://127.0.0.1:${env.MD_PORT || 8787}` : process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!LIVE && (!BASE || !DATA || !DATA.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787))) { console.error('run via test/isolated.js (or pass --live)'); process.exit(2); }
const OUT = path.join(ROOT, 'run', 'screens-insights');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!LIVE) require('./insights-fixture')(DATA);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  require("./skip-tour")(browser);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  // read-only: only GETs reach the server (no answers, no diag beacons)
  await ctx.route('**/*', (route) => (route.request().method() === 'GET' ? route.continue() : route.fulfill({ status: 204, body: '' })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?token=${encodeURIComponent(env.MD_TOKEN)}`, { waitUntil: 'networkidle' });
  await sleep(900);
  const shot = async (n) => { const p = path.join(OUT, n); await page.screenshot({ path: p }); console.log(p); };
  const themes = LIVE ? ['dark'] : ['dark', 'light'];
  for (const theme of themes) {
    await page.evaluate((t) => { localStorage.setItem('md_theme', t); window.MorningDeck.applyTheme(t); }, theme);
    await page.click('#insightsBtn'); await page.waitForSelector('.ins-tiles'); await sleep(700);
    const tag = LIVE ? 'real' : 'fake';
    await shot(`insights-${tag}-${theme}.png`);
    await page.evaluate(() => { const s = document.querySelector('#insightsBody'); s.scrollTop = s.querySelector('.ins-chart, .ins-sec:nth-of-type(2)').offsetTop - 10; }); await sleep(300);
    await shot(`insights-${tag}-${theme}-charts.png`);
    await page.keyboard.press('Escape'); await sleep(300);
  }
  if (!LIVE) { // tap a row in the deck -> jumps to that card
    await page.click('#insightsBtn'); await page.waitForSelector('.ins-row'); await sleep(500);
    await page.click('.ins-row[data-card="fake-dentist-3"]'); await sleep(900);
    const top = await page.evaluate(() => window.MorningDeck.state.deck[0].id);
    console.log('tap jumps to', top); await shot('insights-fake-light-tap-jump.png');
    if (top !== 'fake-dentist-3') { await browser.close(); process.exit(1); }
  }
  await browser.close();
})().catch((e) => { console.error(String(e.message || e).replace(env.MD_TOKEN, '[redacted]')); process.exit(1); });
