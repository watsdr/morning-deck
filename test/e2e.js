// End-to-end check: real touch drags for 4 swipes + 3 rapid taps, screenshots, answer-log verification.
// Usage: node test/isolated.js test/e2e.js   (temp data dir + port 8799; uses system google-chrome via playwright-core)
// It answers every card in the deck, so it refuses to run against the live server unless MD_ALLOW_LIVE=1.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE || `http://127.0.0.1:${env.MD_PORT || 8787}`;
if (new URL(BASE).port === String(env.MD_PORT || 8787) && process.env.MD_ALLOW_LIVE !== '1') { console.error(`refusing to swipe the LIVE deck at ${BASE}; use: node test/isolated.js test/e2e.js`); process.exit(2); }
const SHOTS = path.join(ROOT, 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opts = {}) => (await fetch(BASE + p, { ...opts, headers: { Authorization: `Bearer ${env.MD_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } })).json();

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const since = new Date().toISOString();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    timezoneId: 'America/New_York',
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  const cdp = await ctx.newCDPSession(page);

  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  const finalUrl = page.url();
  await page.waitForSelector('.card[data-depth="0"][data-id]');
  await sleep(1400);
  const shot = async (name) => { const p = path.join(SHOTS, name); await page.screenshot({ path: p }); console.log('shot', p); return p; };
  await shot('01-deck-at-rest.png');

  // ---- PWA checks ----
  const swState = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, active: !!r.active, controller: !!navigator.serviceWorker.controller }; });
  const installErrors = await cdp.send('Page.getInstallabilityErrors').catch((e) => ({ error: e.message }));
  const manifest = await cdp.send('Page.getAppManifest').catch((e) => ({ error: e.message }));

  const topBox = async () => { const el = await page.$('.card[data-depth="0"]:not(.flying)'); return el.boundingBox(); };
  const topId = () => page.$eval('.card[data-depth="0"]:not(.flying)', (n) => n.dataset.id);
  // Virtual finger clock: CDP round-trips are slow (~50ms), so we stamp events like a 60-120Hz touchscreen would.
  let clock = Date.now() / 1000;
  const touch = (type, x, y, dtMs = 16) => {
    clock = type === 'touchStart' ? Math.max(clock + 0.5, Date.now() / 1000) : clock + dtMs / 1000;
    return cdp.send('Input.dispatchTouchEvent', { type, timestamp: clock, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }] });
  };
  // a finger tap on the same virtual clock (mixing clocks confuses Chrome's gesture detector)
  const fingerTap = async (x, y, gapMs = 0) => {
    clock = gapMs ? clock + gapMs / 1000 : Math.max(clock + 0.5, Date.now() / 1000);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: clock, touchPoints: [{ x, y, id: 1 }] });
    clock += 0.055;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: clock, touchPoints: [] });
  };
  // Buttons: Chrome doesn't synthesize a click from CDP touches that carry custom timestamps, so press buttons with a pointer click.
  const tapEl = (sel) => page.click(sel);

  // drag in small steps like a finger; hold at `hold` fraction for a screenshot, then finish & release
  async function drag(dx, dy, { shotName, holdAt = 0.62, steps = 22 } = {}) {
    const b = await topBox();
    const x0 = b.x + b.width / 2, y0 = b.y + b.height * 0.42;
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await touch('touchMove', x0 + dx * t, y0 + dy * t);
      await sleep(14);
      if (shotName && Math.abs(t - holdAt) < 0.5 / steps) { await sleep(120); await shot(shotName); }
    }
    await touch('touchEnd');
    await sleep(750);
  }

  const results = { steps: [] };
  // 0) velocity fling (short, fast) on card 1, then Undo
  const firstId = await topId();
  { const b = await topBox(); const x0 = b.x + b.width / 2, y0 = b.y + b.height * 0.4;
    await touch('touchStart', x0, y0);
    const tf = Date.now(); for (let i = 1; i <= 3; i++) { await touch('touchMove', x0 + i * 30, y0 + i * 3, 12); }
    results.flingMs = Date.now() - tf; results.flingPx = 90;
    await touch('touchEnd'); await sleep(700); }
  const afterFling = await topId();
  results.flingCommitted = afterFling !== firstId;
  await tapEl('#btnUndo');
  await sleep(1100);
  results.undoRestored = (await topId()) === firstId;
  // small drag under threshold should spring back (no answer)
  { const b = await topBox(); const x0 = b.x + b.width / 2, y0 = b.y + b.height * 0.4;
    await touch('touchStart', x0, y0); for (let i = 1; i <= 10; i++) { await touch('touchMove', x0 - i * 5, y0, 30); await sleep(30); } await sleep(200); await touch('touchEnd', 0, 0, 200); await sleep(900); }
  results.springBackKeptCard = (await topId()) === firstId;

  // 1) right on the 1st card (Scheduler)
  results.steps.push({ gesture: 'right', cardId: await topId() });
  await drag(330, 30, { shotName: '02-drag-right.png', holdAt: 0.4 });
  // 2) left on the 2nd card (Work)
  results.steps.push({ gesture: 'left', cardId: await topId() });
  await drag(-330, 24, { shotName: '03-drag-left.png', holdAt: 0.4 });
  // 3) down on the 3rd card (Finance choice: Emergency fund)
  results.steps.push({ gesture: 'down', cardId: await topId() });
  await drag(10, 420, { shotName: '04-drag-down.png', holdAt: 0.32 });
  // 4) up on the 4th card (Later -> snooze)
  results.steps.push({ gesture: 'up', cardId: await topId() });
  await drag(-6, -420, { shotName: '05-drag-up.png', holdAt: 0.32 });
  // 5) triple-tap on the 5th card (open sheet, type, save)
  results.steps.push({ gesture: 'tap3', cardId: await topId() });
  { const b = await topBox(); const x = b.x + b.width / 2, y = b.y + b.height * 0.45;
    for (let i = 0; i < 3; i++) { await fingerTap(x + i * 2, y + i, i ? 140 : 0); await sleep(40); } }
  await page.waitForSelector('#sheetWrap:not([hidden])');
  await sleep(700);
  await page.locator('#replyText').fill('Thanks — remind me about lights-out at 10:30 PM (sample reply).');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(250);
  await shot('06-triple-tap-sheet.png');
  await tapEl('#sheetSave');
  await sleep(1150);
  // 6) built-in feedback card is dealt last; "Love it" (right) clears the deck
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  results.feedbackTopAfterFive = (await topId()) === `morningdeck-feedback-${today}`;
  results.steps.push({ gesture: 'right', cardId: await topId(), feedback: true });
  await drag(330, 20);
  await sleep(500);
  await shot('07-cleared-celebration.png');
  await sleep(3200);
  await shot('08-cleared-summary.png');

  // ---- verify answer log ----
  const log = await api('/api/answers?since=' + encodeURIComponent(since));
  const all = await api('/api/answers?all=1&since=' + encodeURIComponent(since));
  const scheduler = await api('/api/answers?source=scheduler&since=' + encodeURIComponent(since));
  const deck = await api('/api/deck');
  const expected = { right: 'yes', left: 'quiet_compound', down: 'emergency_fund', up: 'snooze', tap3: 'reply' };
  // map cards to their expected value given the actual deck order
  const cards = (await api('/api/cards')).cards;
  results.verify = results.steps.map((s) => {
    const card = s.feedback ? { source: 'Morning Deck', title: 'feedback card', gestures: { right: { value: 'love_it' } } } : cards.find((c) => c.id === s.cardId);
    const want = card.gestures[s.gesture].value;
    const got = log.answers.filter((a) => a.cardId === s.cardId);
    const extra = s.feedback ? got.length === 1 && got[0].source === 'Morning Deck' && got[0].replyTo && got[0].replyTo.bot === 'morning-deck' : true;
    return { gesture: s.gesture, card: `${card.source}: ${card.title}`, expectedValue: want, answers: got.map((a) => ({ gesture: a.gesture, label: a.label, value: a.value, text: a.text, source: a.source, snoozedUntil: a.snoozedUntil })), ok: extra && got.length === 1 && got[0].gesture === s.gesture && got[0].value === want };
  });
  results.activeAnswerCount = log.count;
  results.fullLogCount = all.count;
  results.fullLogGestures = all.answers.map((a) => a.gesture + (a.undone ? '(undone)' : ''));
  results.sourceFilterScheduler = scheduler.answers.map((a) => `${a.source}:${a.gesture}:${a.value}`);
  results.deckAfter = deck.count;
  results.sw = swState; results.installabilityErrors = installErrors; results.manifestUrl = manifest.url; results.manifestErrors = manifest.errors;
  results.finalUrlAfterTokenRedirect = finalUrl.replace(env.MD_TOKEN, '[token]');
  results.consoleErrors = consoleErrors;
  results.allOk = results.verify.every((v) => v.ok) && results.flingCommitted && results.undoRestored && results.springBackKeptCard && results.feedbackTopAfterFive && log.count === 6 && deck.count === 0;
  fs.writeFileSync(path.join(SHOTS, 'verify.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  void expected;
  await browser.close();
  process.exit(results.allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
