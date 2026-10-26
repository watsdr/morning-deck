// Batch 2 checks + phone screenshots (412x915, dark + light) on FAKE data in an isolated temp dir.
//   node test/isolated.js test/screens-batch2.js --empty
// Covers: due line + 'Still relevant?' badge, app tiles, weekly recap (API + view), voice buttons + confirm, QR page,
// manifest shortcuts. Output: run/screens-batch2/. Never prints the token.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!BASE || !D || !D.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
const OUT = path.join(ROOT, 'run', 'screens-batch2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now(), iso = (h) => new Date(now + h * 3600e3).toISOString();
const card = (id, o) => ({ id, source: 'Fake Bot', emoji: '🤖', title: id, body: 'FAKE test card.', type: 'question', priority: 'normal', sample: false, status: 'pending', createdAt: iso(-3), receivedAt: iso(-3), ...o });
const cards = [
  card('fake-renewal', { source: 'Billing Bot', emoji: '💳', title: 'Renew the FAKE domain?', body: 'FAKE: auto-renew is off and the domain lapses tonight.', dueAt: iso(-2), createdAt: iso(-24 * 9), receivedAt: iso(-24 * 9), skipCount: 3 }),
  card('fake-dentist', { source: 'Calendar Bot', emoji: '📅', title: 'Confirm FAKE dentist slot', body: 'FAKE: Tue 9:30 AM, reply yes to confirm.', dueAt: iso(5) }),
  card('fake-report', { source: 'Work Bot', emoji: '📊', title: 'Send the FAKE weekly report?', dueAt: iso(60), createdAt: iso(-24 * 8), receivedAt: iso(-24 * 8) }),
  card('fake-newsletter', { source: 'Inbox Bot', emoji: '📬', title: 'Unsubscribe from FAKE newsletter?', createdAt: iso(-24 * 2), receivedAt: iso(-24 * 2) }),
];
const ans = (id, cardId, gesture, label, h, o = {}) => ({ id, cardId, source: 'Calendar Bot', cardTitle: `FAKE ${cardId}`, cardType: 'question', sample: false, gesture, label, value: label, answeredAt: iso(h), recordedAt: iso(h), ...o });
const answers = [ans('fa1', 'fake-gym', 'right', 'Yes', -1), ans('fa2', 'fake-trip', 'left', 'No', -20, { source: 'Travel Bot' }),
  ans('fa3', 'fake-renewal', 'down', 'Skip', -5, { source: 'Billing Bot' }), ans('fa4', 'fake-old', 'right', 'Yes', -24 * 20)];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(D, 'cards.json'), JSON.stringify(cards)); fs.writeFileSync(path.join(D, 'answers.json'), JSON.stringify(answers));
  const a = spawnSync(process.execPath, ['scripts/assemble.js', '--no-push', '--resolved', '/nonexistent'], { cwd: ROOT, env: { ...process.env, MD_RUN_DIR: path.join(D, 'run') }, encoding: 'utf8' });
  assert.strictEqual(a.status, 0, a.stderr);
  const auth = { headers: { Authorization: `Bearer ${env.MD_TOKEN}` } };
  // recap API
  const unauth = await fetch(`${BASE}/api/recap`); assert.strictEqual(unauth.status, 401);
  const rc = await (await fetch(`${BASE}/api/recap`, auth)).json();
  assert.ok(rc.decisions.some((x) => x.cardId === 'fake-gym'), 'decision this week');
  assert.ok(!rc.decisions.some((x) => x.cardId === 'fake-old'), 'old decision excluded');
  assert.ok(!rc.decisions.some((x) => x.gesture === 'down'), 'skips are not decisions');
  assert.strictEqual(rc.longestSkipped[0].id, 'fake-renewal');
  assert.ok(rc.topWaiting && rc.topWaiting.source, 'a bot is waiting');
  const cardsAfter = JSON.parse(fs.readFileSync(path.join(D, 'cards.json'), 'utf8'));
  assert.strictEqual(cardsAfter.length, cards.length, 'recap never creates cards');
  // manifest shortcuts
  const mf = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  assert.deepStrictEqual(mf.shortcuts.map((s) => s.short_name), ['Deck', 'Recap', 'Main Menu']);
  assert.ok(mf.shortcuts.every((s) => s.url.startsWith('/')), 'same-origin shortcuts');

  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  require("./skip-tour")(browser);
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await ctx.addInitScript(() => { // deterministic voice support in headless Chrome (no real mic / TTS)
    if (!window.webkitSpeechRecognition) window.webkitSpeechRecognition = function () { this.start = () => {}; this.abort = () => {}; };
    window.__badge = []; navigator.setAppBadge = (n) => { window.__badge.push(n); return Promise.resolve(); }; navigator.clearAppBadge = () => { window.__badge.push(0); return Promise.resolve(); };
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?token=${encodeURIComponent(env.MD_TOKEN)}`, { waitUntil: 'networkidle' }); await sleep(1200);
  const shot = async (n) => { const p = path.join(OUT, n); await page.screenshot({ path: p }); console.log(p); };
  const top = await page.evaluate(() => window.MorningDeck.state.deck[0].id);
  assert.ok(['fake-renewal', 'fake-dentist'].includes(top), 'due today / overdue first, got ' + top);
  assert.strictEqual(await page.locator('#appTiles a[href="/main-menu/"]').count(), 1);
  assert.strictEqual(await page.locator('#appTiles a[href="/hub-world/"]').count(), 1);
  assert.ok(await page.locator('.card[data-depth="0"] .due-line.due-over').count(), 'overdue line on the top card');
  assert.ok(await page.locator('.card[data-depth="0"] .chip-relevant').count(), "'Still relevant?' badge");
  { const [b, c] = await page.evaluate(() => [window.__badge, document.querySelector('#countNum').textContent]); assert.strictEqual(b[b.length - 1], +c, 'app badge = pending counter'); }
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { localStorage.setItem('md_theme', t); window.MorningDeck.applyTheme(t); }, theme); await sleep(500);
    await shot(`deck-tiles-due-stale-${theme}.png`);
    await page.click('#tileRecap'); await page.waitForSelector('#recapBody .recap-row'); await sleep(600);
    await shot(`recap-${theme}.png`);
    await page.keyboard.press('Escape'); await sleep(400);
    await page.evaluate(() => { const st = window.MorningDeck.state; const c = st.deck.find((x) => !x.divider); window.MorningDeck.openSheet ? window.MorningDeck.openSheet(c) : null; });
    if (!(await page.locator('#sheetWrap:not([hidden])').count())) { await page.locator('.card[data-depth="0"]').click(); await sleep(300); await page.locator('.card[data-depth="0"]').click(); await page.locator('.card[data-depth="0"]').click(); }
    await page.waitForSelector('#readAloudBtn'); await sleep(500);
    assert.ok(await page.locator('#voiceAnswerBtn').count());
    await page.evaluate(() => { const s = document.querySelector('#sheetScroll'); s.scrollTop = s.scrollHeight; }); await sleep(300);
    await shot(`sheet-voice-${theme}.png`);
    await page.evaluate(() => window.__mdVoice.confirmVoice('yes please')); await sleep(300);
    assert.ok(await page.locator('#voiceConfirm').count(), 'confirmation shown before recording');
    await page.evaluate(() => { const s = document.querySelector('#sheetScroll'); s.scrollTop = s.scrollHeight; }); await sleep(200);
    await shot(`sheet-voice-confirm-${theme}.png`);
    const before = JSON.parse(fs.readFileSync(path.join(D, 'answers.json'), 'utf8')).length;
    await page.click('#voiceCancel'); await sleep(200);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(D, 'answers.json'), 'utf8')).length, before, 'cancel records nothing');
    await page.keyboard.press('Escape'); await sleep(500);
  }
  assert.deepStrictEqual(await page.evaluate(() => ['yes', 'nope', 'later please', 'skip it', 'banana'].map(window.__mdVoice.voiceDir)), ['right', 'left', 'up', 'down', null]);
  // QR page (box-local only)
  for (const theme of ['dark', 'light']) {
    const qp = await ctx.newPage(); await qp.emulateMedia({ colorScheme: theme });
    const r = await qp.goto(`${BASE}/signin/qr`, { waitUntil: 'networkidle' }); assert.strictEqual(r.status(), 200);
    await sleep(500); const p = path.join(OUT, `qr-${theme}.png`); await qp.screenshot({ path: p }); console.log(p); await qp.close();
  }
  await browser.close();
  console.log('screens-batch2: ok');
})().catch((e) => { console.error(String(e.stack || e).split(env.MD_TOKEN).join('[redacted]')); process.exit(1); });
