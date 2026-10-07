// Photos on replies, built-in feedback card, keyboard-safe reply sheet, short confetti.
// Usage: node test/isolated.js test/e2e-photos.js   (needs the fresh SAMPLE deck the runner seeds)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE;
if (!BASE || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via: node test/isolated.js test/e2e-photos.js'); process.exit(2); }
const SHOTS = path.join(ROOT, 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { Authorization: `Bearer ${env.MD_TOKEN}` };
const api = async (p) => (await fetch(BASE + p, { headers: auth })).json();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const FEEDBACK_ID = `morningdeck-feedback-${today}`;

// ---- test PNGs (pure node) ----
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sunset = (w, h) => (x, y) => { const t = y / h, d = Math.hypot(x - w * 0.5, y - h * 0.78) / (w * 0.18); return d < 1 ? [255, 214 - 40 * d, 120] : [40 + 200 * t, 30 + 70 * t, 110 - 20 * t + 40 * Math.sin(x / 90)]; };
const ocean = (w, h) => (x, y) => { const t = y / h; return [20 + 30 * t, 120 + 80 * Math.sin(x / 140 + y / 200) * 0.5 + 40 * t, 200 - 60 * t]; };
const grid = (w, h) => (x, y) => ((x >> 5) + (y >> 5)) & 1 ? [255, 122, 89] : [255, 236, 214];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync('/tmp/md-photos-');
  const files = { a: path.join(tmp, 'sunset-2400x1600.png'), b: path.join(tmp, 'ocean-1200x1800.png'), c: path.join(tmp, 'grid-640x480.png') };
  fs.writeFileSync(files.a, png(2400, 1600, sunset(2400, 1600)));
  fs.writeFileSync(files.b, png(1200, 1800, ocean(1200, 1800)));
  fs.writeFileSync(files.c, png(640, 480, grid(640, 480)));
  const R = { checks: {} };
  const ok = (name, cond, info) => { R.checks[name] = { ok: !!cond, ...(info !== undefined ? { info } : {}) }; console.log(cond ? 'PASS' : 'FAIL', name, info !== undefined ? JSON.stringify(info) : ''); };

  // deck order check (API): feedback card last even though a sample card is "low" and we add a HIGH one
  await fetch(BASE + '/api/cards', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `qa-high-${today}`, source: 'QA Bot', emoji: '🧪', priority: 'high', title: 'High-priority test card', body: 'Posted by the test to prove the feedback card stays last.', createdAt: new Date().toISOString() }) });
  const deck0 = await api('/api/deck');
  ok('feedbackCardLastInDeck', deck0.cards[deck0.cards.length - 1].id === FEEDBACK_ID, deck0.cards.map((c) => `${c.id}:${c.priority}`));
  const fb = deck0.cards.find((c) => c.id === FEEDBACK_ID);
  ok('feedbackCardShape', fb && fb.source === 'Morning Deck' && !fb.sample && fb.gestures.right.label === 'Love it' && fb.gestures.left.value === 'something_off' && fb.gestures.down.value === 'skip' && fb.gestures.up.snooze && fb.gestures.tap3.label === 'Suggest', fb && { emoji: fb.emoji, color: fb.color, gestures: Object.fromEntries(Object.entries(fb.gestures).map(([k, v]) => [k, `${v.label}=${v.value}`])) });

  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED/.test(m.text())) consoleErrors.push(m.text()); }); // offline step is expected to fail fetches
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  const cdp = await ctx.newCDPSession(page);
  const shot = async (name) => { const p = path.join(SHOTS, name); await page.screenshot({ path: p }); console.log('shot', p); return p; };
  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"][data-id]');
  await sleep(1200);
  const topId = () => page.$eval('.card[data-depth="0"]:not(.flying)', (n) => n.dataset.id);
  const topBox = async () => (await page.$('.card[data-depth="0"]:not(.flying)')).boundingBox();
  let clock = Date.now() / 1000;
  const touch = (type, x, y, dt = 16) => { clock = type === 'touchStart' ? Math.max(clock + 0.5, Date.now() / 1000) : clock + dt / 1000; return cdp.send('Input.dispatchTouchEvent', { type, timestamp: clock, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }] }); };
  const fingerTap = async (x, y, gap = 0) => { clock = gap ? clock + gap / 1000 : Math.max(clock + 0.5, Date.now() / 1000); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: clock, touchPoints: [{ x, y, id: 1 }] }); clock += 0.055; await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: clock, touchPoints: [] }); };
  async function drag(dx, dy, steps = 22) { const b = await topBox(); const x0 = b.x + b.width / 2, y0 = b.y + b.height * 0.42; await touch('touchStart', x0, y0); for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + dx * i / steps, y0 + dy * i / steps); await sleep(14); } await touch('touchEnd'); await sleep(800); }
  async function tripleTap() { const b = await topBox(); const x = b.x + b.width / 2, y = b.y + b.height * 0.45; for (let i = 0; i < 3; i++) { await fingerTap(x + i * 2, y + i, i ? 140 : 0); await sleep(40); } await page.waitForSelector('#sheetWrap:not([hidden])'); await sleep(650); }
  const readyThumbs = (n) => page.waitForFunction((n) => document.querySelectorAll('#thumbs .thumb.ready, #thumbs .thumb:not(.loading):not(.leaving)').length === n && !document.querySelector('#thumbs .thumb.loading'), n, { timeout: 15000 });

  // ---------- 1) triple-tap reply with 2 photos ----------
  const card1 = await topId();
  await tripleTap();
  ok('noAutoFocusOnOpen', await page.evaluate(() => document.activeElement !== document.getElementById('replyText')));
  await page.setInputFiles('#photoInput', [files.a, files.b]);
  await readyThumbs(2);
  await page.setInputFiles('#photoInput', [files.c]); // add a 3rd, then remove it with its x
  await readyThumbs(3);
  await page.click('#thumbs .thumb:last-child .thumb-x');
  await sleep(400);
  ok('removeThumb', (await page.$$eval('#thumbs .thumb', (n) => n.length)) === 2);
  const processed = await page.evaluate(() => window.MorningDeck.state.photos.map((p) => ({ mime: p.mime, w: p.width, h: p.height, kb: Math.round(p.blob.size / 1024) })));
  ok('clientDownscale<=1600', processed.every((p) => Math.max(p.w, p.h) <= 1600) && processed[0].w === 1600 && /image\/(webp|jpeg)/.test(processed[0].mime), processed);
  await page.locator('#replyText').fill('Here’s what I mean, see the two photos.');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(400);
  await shot('09-reply-with-photos.png');

  // ---------- 2) keyboard: resized layout viewport (interactive-widget=resizes-content) ----------
  const vis = (h) => page.evaluate((H) => Object.fromEntries(['#replyText', '#photoBtn', '#sheetSave'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [s, { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top >= 0 && r.bottom <= H && r.height > 0 }]; })), h);
  await page.tap('#replyText');
  await sleep(150);
  await page.setViewportSize({ width: 412, height: 500 });
  await sleep(900);
  const kb1 = await vis(500);
  ok('keyboardResize:inputPhotoSaveVisible', Object.values(kb1).every((v) => v.visible) && await page.$eval('#sheetWrap', (n) => n.classList.contains('kb')), kb1);
  await shot('11-reply-keyboard.png');
  await page.setViewportSize({ width: 412, height: 915 });
  await sleep(600);
  // ---------- 2b) keyboard: overlay mode (layout stays 915, visualViewport shrinks) ----------
  await page.evaluate(() => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 515 });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    document.getElementById('replyText').focus();
    vv.dispatchEvent(new Event('resize'));
  });
  await sleep(700);
  const kb2 = await vis(515);
  const kbVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb'));
  ok('keyboardOverlay:inputPhotoSaveVisible', Object.values(kb2).every((v) => v.visible) && kbVar.trim() === '400px', { kb: kbVar, ...kb2 });
  await page.evaluate(() => { const vv = window.visualViewport; delete vv.height; delete vv.offsetTop; document.activeElement.blur(); vv.dispatchEvent(new Event('resize')); });
  await sleep(500);

  // ---------- 3) save -> answer has attachments, GET urls work, files on disk ----------
  await page.click('#sheetSave');
  await sleep(2500);
  const a1 = (await api('/api/answers?cardId=' + encodeURIComponent(card1))).answers[0];
  const att = (a1 && a1.attachments) || [];
  const fetched = [];
  for (const x of att) { const r = await fetch(BASE + x.url, { headers: auth }); const b = Buffer.from(await r.arrayBuffer()); fetched.push({ status: r.status, type: r.headers.get('content-type'), bytes: b.length, onDisk: fs.existsSync(x.path) && fs.statSync(x.path).size === x.size, pathInDataDir: x.path.startsWith(process.env.MD_DATA_DIR) }); }
  const unauth = att[0] ? (await fetch(BASE + att[0].url)).status : null;
  ok('answerHasTwoAttachments', a1 && a1.gesture === 'tap3' && att.length === 2 && att.every((x) => x.id && x.url && x.mime && x.size && x.path && x.width && x.height), a1 && { text: a1.text, attachments: att });
  ok('attachmentUrlsServe+filesOnDisk', fetched.length === 2 && fetched.every((f) => f.status === 200 && /^image\//.test(f.type) && f.onDisk && f.pathInDataDir) && unauth === 401, { fetched, unauthStatus: unauth });

  // ---------- 4) photo-only reply via the Reply button ----------
  const card2 = await topId();
  await page.click('.act-tap3'); await page.waitForSelector('#sheetWrap:not([hidden])'); await sleep(500);
  await page.setInputFiles('#photoInput', [files.c]); await readyThumbs(1);
  ok('saveEnabledWithPhotoOnly', !(await page.$eval('#sheetSave', (b) => b.disabled)));
  await page.click('#sheetSave'); await sleep(2000);
  const a2 = (await api('/api/answers?cardId=' + encodeURIComponent(card2))).answers[0];
  ok('photoOnlyReplySaved', a2 && a2.gesture === 'tap3' && !a2.text && a2.attachments && a2.attachments.length === 1, a2 && { text: a2.text ?? null, attachments: a2.attachments.length });

  // ---------- 5) offline: reply + photo is queued in IndexedDB, syncs on reconnect ----------
  const card3 = await topId();
  await ctx.setOffline(true);
  await page.click('.act-tap3'); await page.waitForSelector('#sheetWrap:not([hidden])'); await sleep(500);
  await page.setInputFiles('#photoInput', [files.b]); await readyThumbs(1);
  await page.locator('#replyText').fill('Sent while offline');
  await page.click('#sheetSave'); await sleep(1500);
  const queued = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('morning-deck', 1); r.onsuccess = () => { const q = r.result.transaction('outbox').objectStore('outbox').getAll(); q.onsuccess = () => res(q.result.map((i) => ({ cardId: i.payload.cardId, photos: i.photos.length, blob: i.photos[0].blob instanceof Blob }))); }; }));
  const pill = await page.$eval('#statusPill', (n) => (n.hidden ? '' : n.textContent));
  const toastText = await page.$eval('#toast', (n) => n.textContent);
  ok('offlineQueuedWithPhotos', queued.length === 1 && queued[0].cardId === card3 && queued[0].photos === 1 && queued[0].blob && /waiting to sync/.test(pill), { queued, pill, toast: toastText });
  await shot('13-offline-queued.png');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(2500);
  const a3 = (await api('/api/answers?cardId=' + encodeURIComponent(card3))).answers[0];
  const left = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('morning-deck', 1); r.onsuccess = () => { const q = r.result.transaction('outbox').objectStore('outbox').count(); q.onsuccess = () => res(q.result); }; }));
  ok('offlineReplySyncedAfterReconnect', a3 && a3.text === 'Sent while offline' && a3.attachments.length === 1 && left === 0, a3 && { text: a3.text, attachments: a3.attachments.length, idbLeft: left });

  // ---------- 6) answer the rest until only the feedback card is left ----------
  for (let i = 0; i < 10 && (await topId()) !== FEEDBACK_ID; i++) await drag(0, 420); // down = Skip
  ok('feedbackCardIsLastOnScreen', (await topId()) === FEEDBACK_ID && (await page.$$eval('.card[data-id]:not(.flying)', (n) => n.length)) === 1);
  await sleep(900);
  await shot('10-feedback-card.png');
  const ui = await page.evaluate(() => ({ right: document.querySelector('.act[data-g="right"] span').textContent, left: document.querySelector('.act[data-g="left"] span').textContent, down: document.querySelector('.act[data-g="down"] span').textContent, up: document.querySelector('.act[data-g="up"] span').textContent, tap3: document.querySelector('.act-tap3 span').textContent, ribbon: !!document.querySelector('.card[data-builtin] .ribbon') }));
  ok('feedbackLabels', ui.right === 'Love it' && ui.left === "Something's off" && ui.down === 'Skip' && ui.up === 'Later' && ui.tap3 === 'Suggest' && !ui.ribbon, ui);

  // swipe LEFT = "Something's off" -> opens the sheet in explain mode (nothing recorded yet)
  await drag(-330, 10);
  await page.waitForSelector('#sheetWrap:not([hidden])'); await sleep(500);
  const mode = await page.evaluate(() => ({ mode: document.getElementById('sheetWrap').dataset.mode, save: document.getElementById('sheetSave').textContent, label: document.getElementById('replyLabel').textContent, saveEnabled: !document.getElementById('sheetSave').disabled }));
  const before = (await api('/api/answers?cardId=' + FEEDBACK_ID)).count;
  ok('leftOpensExplainSheet', mode.mode === 'left' && before === 0 && mode.saveEnabled, mode);
  await page.locator('#replyText').fill('The Reply button is hard to reach one-handed.');
  await page.setInputFiles('#photoInput', [files.c]); await readyThumbs(1);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(300);
  await shot('10b-feedback-something-off.png');
  await page.click('#sheetSave');
  await sleep(1300);
  await shot('07b-cleared-confetti.png');
  await sleep(1200); // ~2.5 s after the deck cleared
  const canvas = await page.$eval('#confetti', (c) => ({ hidden: c.hidden, w: c.width, h: c.height, pe: getComputedStyle(c).pointerEvents }));
  ok('confettiGoneBy2.5s', canvas.hidden && canvas.w === 0 && canvas.pe === 'none', canvas);
  await shot('12-cleared-after-2s.png');
  const fa = (await api('/api/answers?cardId=' + FEEDBACK_ID)).answers;
  ok('feedbackAnswerRecorded', fa.length === 1 && fa[0].source === 'Morning Deck' && fa[0].gesture === 'left' && fa[0].value === 'something_off' && fa[0].replyTo && fa[0].replyTo.bot === 'morning-deck' && fa[0].attachments.length === 1, fa[0]);
  const deckAfter = await api('/api/deck');
  ok('feedbackGoneAfterAnswer', !deckAfter.cards.some((c) => c.id === FEEDBACK_ID), deckAfter.count);
  // summary tappable (confetti canvas not in the way)
  await page.evaluate(() => document.getElementById('refreshBtn').scrollIntoView({ block: 'center' })); await sleep(300);
  ok('summaryTappable', await page.evaluate(() => { const b = document.getElementById('refreshBtn').getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e && e.id === 'refreshBtn'; }));

  R.consoleErrors = consoleErrors;
  R.allOk = Object.values(R.checks).every((c) => c.ok) && !consoleErrors.length;
  fs.writeFileSync(path.join(SHOTS, 'verify-photos.json'), JSON.stringify(R, null, 2));
  console.log('consoleErrors', consoleErrors);
  console.log('allOk', R.allOk);
  await browser.close();
  process.exit(R.allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
