// Phone-size (390x844) screenshots of the deck, Settings (Notify me), History (dark + light) and the reply sheet.
// Usage: node test/isolated.js test/screens.js [--out DIR]   (SAMPLE data in a temp dir; never the live deck)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!BASE || !DATA || !DATA.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(ROOT, 'run', 'screens-' + new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: { Authorization: `Bearer ${env.MD_TOKEN}`, 'Content-Type': 'application/json' } })).json();
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // a few answers on SAMPLE cards so History has rows (one reply, one undone)
  const deck = (await api('/api/deck')).cards.filter((c) => !c.builtin);
  await api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: deck[0].id, gesture: 'right' }) });
  await api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: deck[1].id, gesture: 'tap3', text: 'Before I decide: what does the other option cost?' }) });
  const u = await api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: deck[2].id, gesture: 'left' }) });
  await api('/api/answers/undo', { method: 'POST', body: JSON.stringify({ answerId: u.answer.id }) });
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', permissions: ['notifications'] });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"][data-id]'); await sleep(1200);
  const shot = async (n) => { const p = path.join(OUT, n); await page.screenshot({ path: p }); console.log(p); };
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { localStorage.setItem('md_theme', t); window.MorningDeck.applyTheme(t); }, theme); await sleep(400);
    await shot(`deck-${theme}.png`);
    await page.click('#settingsBtn'); await page.waitForSelector('#settingsWrap:not([hidden])'); await sleep(700);
    await shot(`settings-notify-${theme}.png`);
    await page.click('#historyBtn'); await page.waitForSelector('.hist-row'); await sleep(700);
    await shot(`history-${theme}.png`);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await sleep(300);
  }
  await page.evaluate(() => { localStorage.setItem('md_theme', 'dark'); window.MorningDeck.applyTheme('dark'); window.MorningDeck.openSheet(window.MorningDeck.state.deck.find((c) => !c.builtin && !(c.rawGestures && c.rawGestures.tap3 && c.rawGestures.tap3.prompt))); });
  await sleep(800); await shot('reply-sheet-ask-bot.png');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
