// Static demo check (no server): 5 touch gestures, undo, feedback card last, cleared screen, no console errors.
// Usage: node test/pages-demo.js <url> [screenshot.png]
//   e.g. node test/pages-demo.js https://<user>.github.io/morning-deck/ screenshots/pages-demo.png
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const URL_ = process.argv[2];
const SHOT = process.argv[3] || path.join(__dirname, '..', 'screenshots', 'pages-demo.png');
if (!URL_) { console.error('usage: node test/pages-demo.js <url> [screenshot.png]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  const errors = [], requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure() && r.failure().errorText}`));
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  const cdp = await ctx.newCDPSession(page);
  const resp = await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"][data-id]', { timeout: 15000 });
  await sleep(1500);
  const R = { url: URL_, status: resp.status(), checks: {} };
  const ok = (n, c, i) => { R.checks[n] = { ok: !!c, ...(i !== undefined ? { info: i } : {}) }; console.log(c ? 'PASS' : 'FAIL', n, i !== undefined ? JSON.stringify(i) : ''); };
  const st = () => page.evaluate(() => ({ deck: window.MorningDeck.state.deck.map((c) => c.id), session: window.MorningDeck.state.session.map((e) => `${e.card.source}:${e.gesture}:${e.payload.value}`) }));
  const topId = () => page.$eval('.card[data-depth="0"]:not(.flying)', (n) => n.dataset.id);
  const topBox = async () => (await page.$('.card[data-depth="0"]:not(.flying)')).boundingBox();
  let clock = Date.now() / 1000;
  const touch = (type, x, y, dt = 16) => { clock = type === 'touchStart' ? Math.max(clock + 0.5, Date.now() / 1000) : clock + dt / 1000; return cdp.send('Input.dispatchTouchEvent', { type, timestamp: clock, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }] }); };
  const fingerTap = async (x, y, gap = 0) => { clock = gap ? clock + gap / 1000 : Math.max(clock + 0.5, Date.now() / 1000); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: clock, touchPoints: [{ x, y, id: 1 }] }); clock += 0.055; await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: clock, touchPoints: [] }); };
  async function drag(dx, dy, steps = 22) { const b = await topBox(); const x0 = b.x + b.width / 2, y0 = b.y + b.height * 0.42; await touch('touchStart', x0, y0); for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + dx * i / steps, y0 + dy * i / steps); await sleep(14); } await touch('touchEnd'); await sleep(800); }

  const s0 = await st();
  const ui = await page.evaluate(() => ({ demoBanner: !document.getElementById('demoBanner').hidden && document.getElementById('demoBanner').innerText.replace(/\s+/g, ' '), greeting: document.getElementById('greeting').textContent, photoHidden: document.querySelector('.photo-row').hidden, swScope: null }));
  ui.swScope = await page.evaluate(async () => { try { const r = await navigator.serviceWorker.ready; return r.scope; } catch (e) { return String(e); } });
  ok('deckRendered+feedbackLast', s0.deck.length === 6 && /^morningdeck-feedback-\d{4}-\d{2}-\d{2}$/.test(s0.deck[5]), s0.deck);
  ok('demoBanner+noName+photoHidden', /demo/i.test(ui.demoBanner || '') && /nothing is saved/i.test(ui.demoBanner) && !/,/.test(ui.greeting.split('·')[0]) && ui.photoHidden, ui);
  ok('swUnderSubpath', typeof ui.swScope === 'string' && new URL(URL_).href.startsWith(ui.swScope), ui.swScope);
  await page.screenshot({ path: SHOT });
  // undo round trip
  const first = await topId();
  await drag(330, 20);
  await page.click('#btnUndo'); await sleep(1100);
  ok('undoRestoresCard', (await topId()) === first && (await st()).session.length === 0);
  // 5 gestures
  await drag(330, 30);            // right
  await drag(-330, 24);           // left
  await drag(10, 420);            // down
  await drag(-6, -420);           // up (snooze)
  { const b = await topBox(); const x = b.x + b.width / 2, y = b.y + b.height * 0.45; for (let i = 0; i < 3; i++) { await fingerTap(x + i * 2, y + i, i ? 140 : 0); await sleep(40); } }
  await page.waitForSelector('#sheetWrap:not([hidden])'); await sleep(600);
  await page.locator('#replyText').fill('Looks great from the demo');
  await page.click('#sheetSave'); await sleep(1200);
  const s1 = await st();
  ok('fiveGesturesRecorded', s1.session.length === 5 && ['right', 'left', 'down', 'up', 'tap3'].every((g, i) => s1.session[i].split(':')[1] === g), s1.session);
  ok('feedbackCardIsLast', s1.deck.length === 1 && s1.deck[0].startsWith('morningdeck-feedback-') && (await topId()) === s1.deck[0]);
  await drag(330, 10);            // Love it
  await sleep(2600);
  const cleared = await page.evaluate(() => ({ visible: !document.getElementById('cleared').hidden, title: document.querySelector('#cleared h2').textContent, sub: document.getElementById('clearedSub').textContent, items: document.querySelectorAll('#summaryList li').length, canvasHidden: document.getElementById('confetti').hidden }));
  ok('clearedScreen', cleared.visible && cleared.items === 6 && /demo/i.test(cleared.sub) && cleared.canvasHidden, cleared);
  await page.screenshot({ path: SHOT.replace(/\.png$/, '-cleared.png') });
  const s2 = await st();
  ok('feedbackAnsweredLoveIt', s2.session[5] === 'Morning Deck:right:love_it', s2.session[5]);
  ok('noApiRequestsHitNetwork', !requests.some((p) => p.includes('/api/')), requests.filter((p) => p.includes('/api/')));
  await page.reload({ waitUntil: 'networkidle' }); await sleep(1200);
  ok('reloadGivesFreshDeck', (await st()).deck.length === 6);
  ok('noConsoleErrors', errors.length === 0, errors);
  R.allOk = Object.values(R.checks).every((c) => c.ok);
  console.log('allOk', R.allOk);
  await browser.close();
  process.exit(R.allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
