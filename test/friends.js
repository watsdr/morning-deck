// Morning Deck for Friends: end-to-end check at 412x915 (Pixel-like, touch).
// Usage: node test/friends.js <base-url-of-friends-app> [screenshot-dir]
//   e.g. node test/friends.js http://127.0.0.1:8796/morning-deck/friends/ screenshots-friends
// Real network: Open-Meteo (weather), RSS (a direct-CORS feed + the rss2json relay), a real ICS link (expected CORS block).
// Mocked: Todoist, GitHub, Google (GIS + APIs), Microsoft (MSAL + Graph), ntfy (see test/friends-mocks.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const mocks = require('./friends-mocks');
const BASE = process.argv[2];
const SHOTS = path.resolve(process.argv[3] || path.join(__dirname, '..', 'screenshots-friends'));
if (!BASE) { console.error('usage: node test/friends.js <friends-url> [screenshot-dir]'); process.exit(2); }
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = {};
const ok = (n, c, info) => { checks[n] = { ok: !!c, ...(info !== undefined ? { info } : {}) }; console.log(c ? 'PASS' : 'FAIL', n, info !== undefined ? JSON.stringify(info).slice(0, 400) : ''); };
const DEVICE = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' };
// Expected console noise: the deliberate CORS-blocked ICS fetch and the GitHub notifications 403.
const EXPECTED = [/feeds\.bbci\.co\.uk.*blocked by CORS policy/i, /calendar\.google\.com.*(CORS|Access-Control)/i, /Failed to load resource.*(403|404)/i, /blocked by CORS policy.*calendar\.google\.com/i, /net::ERR_FAILED/i];

function pageKit(page, ctx) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  let cdp, clock = Date.now() / 1000;
  const touch = async (type, x, y, dt = 16) => { cdp = cdp || (await ctx.newCDPSession(page)); clock = type === 'touchStart' ? Math.max(clock + 0.5, Date.now() / 1000) : clock + dt / 1000; return cdp.send('Input.dispatchTouchEvent', { type, timestamp: clock, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }] }); };
  const topBox = async () => (await page.$('.card[data-depth="0"]:not(.flying)')).boundingBox();
  const drag = async (dx, dy, steps = 20) => { const b = await topBox(); const x0 = b.x + b.width / 2, y0 = b.y + b.height * 0.42; await touch('touchStart', x0, y0); for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + dx * i / steps, y0 + dy * i / steps); await sleep(12); } await touch('touchEnd'); await sleep(850); };
  const fingerTap = async (x, y, gap) => { cdp = cdp || (await ctx.newCDPSession(page)); clock = gap ? clock + gap / 1000 : Math.max(clock + 0.5, Date.now() / 1000); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: clock, touchPoints: [{ x, y, id: 1 }] }); clock += 0.055; await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: clock, touchPoints: [] }); };
  const tripleTap = async () => { const b = await topBox(); const x = b.x + b.width / 2, y = b.y + b.height * 0.45; for (let i = 0; i < 3; i++) { await fingerTap(x + i * 2, y + i, i ? 140 : 0); await sleep(40); } };
  const deck = () => page.evaluate(() => window.MorningDeck.state.deck.map((c) => ({ id: c.id, service: c.service, priority: c.priority, sample: !!c.sample, title: c.title, source: c.source })));
  const topId = () => page.$eval('.card[data-depth="0"]:not(.flying)', (n) => n.dataset.id).catch(() => null);
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name) });
  const unexpected = () => errors.filter((e) => !EXPECTED.some((re) => re.test(e)));
  return { errors, unexpected, drag, tripleTap, deck, topId, shot };
}
// bring a card to the top by skipping (down) the ones before it; returns false if not found
async function bringToTop(page, kit, pred) {
  for (let i = 0; i < 30; i++) {
    const d = await kit.deck(); const idx = d.findIndex(pred);
    if (idx < 0) return false; if (idx === 0) return true;
    await page.evaluate(() => window.MorningDeck.swipe('down')); await sleep(700);
  }
  return false;
}
async function openTile(page, id) { await page.click(`.mdf-overlay .mdf-tile[data-svc="${id}"]`); await page.waitForSelector(`.mdf-service[data-svc="${id}"]`); await sleep(350); }
const panel = (id) => `.mdf-service[data-svc="${id}"]`;
async function testAndWait(page, id, re = /\S/, timeout = 25000) {
  await page.$eval(`${panel(id)} .f-status`, (n) => { n.textContent = ''; n.hidden = true; });
  await page.click(`${panel(id)} [data-act="test"]`);
  await page.waitForFunction(({ sel, src }) => { const s = document.querySelector(sel + ' .f-status'); return s && !s.hidden && new RegExp(src, 'i').test(s.textContent) && !/^Testing/.test(s.textContent); }, { sel: panel(id), src: re.source }, { timeout });
  return page.$eval(`${panel(id)} .f-status`, (n) => ({ text: n.textContent, cls: n.className }));
}
const previews = (page, id) => page.$$eval(`${panel(id)} .mdf-mini`, (ns) => ns.map((n) => ({ title: n.querySelector('.mdf-mini-title').textContent, src: n.querySelector('b').textContent })));
async function save(page, id) { await page.click(`${panel(id)} [data-act="save"]`); await page.waitForSelector(panel(id), { state: 'detached' }); await sleep(300); }

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const log = [];

  // ===================== A: friend without owner client IDs =====================
  const ctx = await browser.newContext({ ...DEVICE, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const { ntfy } = await mocks.install(ctx, log);
  await ctx.addInitScript(() => { window.__shares = []; navigator.share = async (d) => { window.__shares.push({ title: d.title, text: d.text, files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) }); }; navigator.canShare = () => true; });
  const page = await ctx.newPage(); const kit = pageKit(page, ctx);
  const resp = await page.goto(BASE, { waitUntil: 'networkidle' });
  ok('served', resp.status() === 200, resp.status());

  // 1. landing
  await page.waitForSelector('.mdf-landing.shown'); await sleep(500);
  const land = await page.evaluate(() => ({ h1: document.querySelector('.mdf-landing h1').textContent, text: document.querySelector('.mdf-landing').innerText }));
  ok('landing', /one swipe/.test(land.h1) && /stays on this phone/.test(land.text), land.h1);
  await kit.shot('01-landing.png');
  await page.click('#landingTry'); await page.waitForSelector('.mdf-landing', { state: 'detached' });

  // 2. sample deck, immediately, no sign-up
  await page.waitForSelector('.card[data-depth="0"][data-id]'); await sleep(900);
  let d = await kit.deck();
  const ribbons = await page.$$eval('.card .ribbon', (n) => n.length);
  ok('demoDeck', d.length === 10 && d.slice(0, 9).every((c) => c.sample) && d[9].id.startsWith('morningdeck-feedback-') && ribbons >= 1, { n: d.length, ribbons, services: d.map((c) => c.service) });
  const banner = await page.evaluate(() => !document.getElementById('demoBanner').hidden && document.getElementById('demoBanner').innerText.replace(/\s+/g, ' '));
  ok('demoBannerMakeItMine', /Sample/i.test(banner) && /Make it mine/.test(banner), banner);
  await sleep(3600); // install pill fallback appears after 4s
  await kit.shot('02-demo-deck.png');

  // 3. gestures on the demo: drag right, undo, left, up, down, triple-tap reply with photo
  const first = await kit.topId();
  await kit.drag(330, 20); await page.click('#btnUndo'); await sleep(1100);
  ok('demoUndo', (await kit.topId()) === first);
  await kit.drag(330, 30); await kit.drag(-330, 24); await kit.drag(-6, -420); await kit.drag(10, 420);
  await kit.tripleTap(); await page.waitForSelector('#sheetWrap:not([hidden])'); await sleep(600);
  await page.fill('#replyText', 'Note from the sample deck');
  const photo = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 200 } });
  const photoPath = path.join(os.tmpdir(), 'mdf-test-photo.png'); fs.writeFileSync(photoPath, photo);
  await page.setInputFiles('#photoInput', photoPath); await page.waitForFunction(() => document.querySelectorAll('#thumbs img, #thumbs .thumb').length > 0, null, { timeout: 8000 }).catch(() => {});
  await sleep(600); await page.click('#sheetSave'); await sleep(1500);
  const sess = await page.evaluate(() => window.MorningDeck.state.session.map((e) => e.gesture + (e.photos && e.photos.length ? '+photo' : '')));
  ok('demoFiveGestures', sess.join(',') === 'right,left,up,down,tap3+photo', sess);
  const photosStored = await page.evaluate(() => window.MDF.idb.all().then((l) => l.length));
  ok('photoStoredLocally', photosStored >= 1, photosStored);

  // 4. Google/Microsoft without client IDs -> "needs setup", the rest keeps going
  await page.click('#settingsBtn'); await page.waitForSelector('.mdf-settings.shown');
  await page.click('[data-act="add-service"]'); await page.waitForSelector('.mdf-overlay .mdf-tile[data-svc="gcal"]'); await sleep(300);
  const badges = await page.$$eval('.mdf-overlay:last-child .mdf-tile', (ns) => Object.fromEntries(ns.map((n) => [n.dataset.svc, n.querySelector('.mdf-badge').textContent])));
  ok('oauthNeedsSetupBadges', ['gcal', 'gmail', 'gtasks', 'outlook', 'mscal', 'mstodo'].every((k) => badges[k] === 'Needs setup') && badges.weather === 'Free' && badges.notion === 'Soon', badges);
  await openTile(page, 'gcal');
  const setupText = await page.$eval(panel('gcal'), (n) => n.innerText);
  ok('oauthNeedsSetupPanel', /Needs setup/.test(setupText) && /work right now/.test(setupText), setupText.slice(0, 160));
  await page.click(`${panel('gcal')} .mdf-back`); await sleep(300);
  await openTile(page, 'notion');
  const soonText = await page.$eval(panel('notion'), (n) => n.innerText);
  ok('comingSoonReason', /Coming soon/.test(soonText) && /integration/.test(soonText), soonText.slice(0, 160));
  await page.evaluate(() => window.MDF.ui.closeAll()); await sleep(400);

  // 5. wizard
  await page.click('#makeMineBtn'); await page.waitForSelector('.mdf-wizard.shown'); await sleep(400);
  await page.fill('#wizName', 'Sam');
  await kit.shot('03-wizard-name.png');
  await page.click('[data-act="wiz-next"]'); await page.fill('#wizTime', '07:30');
  await page.click('[data-act="wiz-next"]'); await page.check('input[name="gpreset"][value="donenot"]'); await sleep(200);
  await page.click('[data-act="wiz-next"]'); await page.waitForSelector('.mdf-wizard .mdf-tile[data-svc="weather"]'); await sleep(400);
  await kit.shot('04-service-picker.png');

  // 5a. Weather: real Open-Meteo geocoding + forecast
  await openTile(page, 'weather');
  await page.fill(`${panel('weather')} input[type="search"]`, 'Lisbon'); await page.click(`${panel('weather')} .f-row .f-btn`);
  await page.waitForSelector(`${panel('weather')} .f-result`, { timeout: 20000 }); await page.click(`${panel('weather')} .f-result >> nth=0`);
  let st = await testAndWait(page, 'weather');
  let pv = await previews(page, 'weather');
  ok('weatherReal', /Works ✓/.test(st.text) && pv.length >= 1 && /°/.test(JSON.stringify(pv)), { st: st.text, pv });
  await page.$eval(`${panel('weather')} .mdf-preview`, (n) => n.scrollIntoView({ block: 'center' })); await sleep(300);
  await kit.shot('05-weather-real-preview.png');
  await save(page, 'weather');

  // 5b. News: a direct-CORS feed (NYT) + a relay feed (BBC via rss2json)
  await openTile(page, 'news');
  await page.check(`${panel('news')} input[data-feed="bbc"]`);
  st = await testAndWait(page, 'news', /Works ✓|feed|Couldn|relay/i, 30000);
  pv = await previews(page, 'news');
  ok('newsReal', /Works ✓/.test(st.text) && pv.length >= 1, { st: st.text, pv: pv.map((x) => x.src + ': ' + x.title) });
  const viaRelay = await page.evaluate(() => window.MDF.fetchFeed('https://feeds.bbci.co.uk/news/rss.xml', true).then((r) => ({ via: r.via, n: r.items.length, t: r.items[0] && r.items[0].title })).catch((e) => ({ err: e.message })));
  const direct = await page.evaluate(() => window.MDF.fetchFeed('https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', false).then((r) => ({ via: r.via, n: r.items.length })).catch((e) => ({ err: e.message })));
  ok('rssDirectAndRelay', direct.via === 'direct' && direct.n > 0 && viaRelay.via === 'relay' && viaRelay.n > 0, { direct, viaRelay });
  await save(page, 'news');

  // 5c. Todoist (mocked) + "Let swipes act"
  await openTile(page, 'todoist');
  await page.fill(`${panel('todoist')} input[data-field="token"]`, 'not-a-token');
  st = await testAndWait(page, 'todoist', /look like/i); ok('todoistValidates', /look like/.test(st.text), st.text);
  await page.fill(`${panel('todoist')} input[data-field="token"]`, '0123456789abcdef0123456789abcdef01234567');
  st = await testAndWait(page, 'todoist'); pv = await previews(page, 'todoist');
  ok('todoistMocked', /Works ✓ · Test Friend · 3 cards/.test(st.text) && pv.length === 3, { st: st.text, pv });
  await page.click(`${panel('todoist')} .mdf-switch`); await sleep(200);
  await save(page, 'todoist');

  // 5d. GitHub (mocked; notifications 403 handled)
  await openTile(page, 'github');
  await page.fill(`${panel('github')} input[data-field="token"]`, 'ghp_' + 'FAKEtoken'.repeat(4));
  st = await testAndWait(page, 'github'); pv = await previews(page, 'github');
  ok('githubMocked', /Works ✓ · test-friend · 2 cards/.test(st.text) && /Notifications skipped/.test(st.text) && pv.some((x) => /Review: Add dark mode/.test(x.title)), { st: st.text, pv });
  await save(page, 'github');

  // 5e. Universal inbox (mocked ntfy; the box can't reach ntfy.sh): instructions + test card round trip
  await openTile(page, 'inbox');
  const inboxText = await page.$eval(panel('inbox'), (n) => n.innerText);
  const platforms = await page.$$eval(`${panel('inbox')} details[data-platform]`, (ns) => ns.map((n) => n.dataset.platform));
  const topic = await page.evaluate(() => document.querySelector('.mdf-service[data-svc="inbox"] .f-code').textContent.split('/').pop());
  ok('inboxInstructions', ['Zapier', 'IFTTT', 'Make', 'Apple Shortcuts', 'Home Assistant', 'curl / anything else'].every((p) => platforms.includes(p)) && /12 hours/.test(inboxText) && /^md-[a-z0-9]{20,}$/.test(topic), { platforms, topic });
  await page.$eval(`${panel('inbox')} .mdf-scroll`, (n) => { n.scrollTop = 0; }); await sleep(2200); // let the previous toast fade
  await kit.shot('06-inbox-instructions.png');
  await page.click(`${panel('inbox')} details[data-platform="Home Assistant"] summary`); await sleep(200);
  await page.$eval(`${panel('inbox')} details[data-platform="Home Assistant"]`, (n) => n.scrollIntoView({ block: 'center' })); await sleep(300);
  const haYaml = await page.$eval(`${panel('inbox')} details[data-platform="Home Assistant"] .f-code`, (n) => n.textContent);
  ok('inboxHomeAssistantYaml', /rest_command:/.test(haYaml) && haYaml.includes(topic), haYaml.slice(0, 120));
  await kit.shot('06b-inbox-home-assistant.png');
  await page.click(`${panel('inbox')} [data-act="send-test"]`);
  await page.waitForFunction(() => document.querySelectorAll('.mdf-service[data-svc="inbox"] .mdf-mini').length > 0 && /Hello from your universal inbox/.test(document.querySelector('.mdf-service[data-svc="inbox"] .mdf-preview').innerText), null, { timeout: 15000 });
  ok('inboxRoundTripMocked', ntfy.msgs.length === 1 && ntfy.msgs[0].topic === topic, ntfy.msgs.map((m) => m.title));
  await save(page, 'inbox');

  // 5f. Calendar link: real Google ICS URL -> CORS blocked (reported), then .ics import works
  await openTile(page, 'ics');
  await page.fill(`${panel('ics')} input[type="url"] >> nth=0`, 'https://calendar.google.com/calendar/ical/example%40gmail.com/private-0123456789abcdef/basic.ics');
  st = await testAndWait(page, 'ics', /CORS|doesn|took too long|answered/i, 25000);
  ok('icsCorsBlockedReported', /CORS/.test(st.text) && /Google\/Microsoft sign-in|import/.test(st.text), st.text);
  await page.fill(`${panel('ics')} input[type="url"] >> nth=0`, '');
  await page.evaluate(() => { const i = document.querySelector('.mdf-service[data-svc="ics"] input[type="email"]'); i.value = 'me@example.com'; i.dispatchEvent(new Event('input')); });
  const icsPath = path.join(os.tmpdir(), 'mdf-test.ics'); fs.writeFileSync(icsPath, mocks.icsSample());
  await page.setInputFiles(`${panel('ics')} input[type="file"]`, icsPath); await sleep(500);
  st = await testAndWait(page, 'ics'); pv = await previews(page, 'ics');
  ok('icsImportCards', /Works ✓/.test(st.text) && pv.length === 3, { st: st.text, pv });
  const icsAll = await page.evaluate(() => { const c = window.MDF.services.get('ics'); return c.fetch({ file: 'x', email: 'me@example.com' }, window.MDF.ctx('ics')).then((l) => l.map((x) => x.chip + ': ' + x.title)); });
  ok('icsConflictRsvpAllDay', icsAll.some((t) => /^Conflict/.test(t)) && icsAll.some((t) => /^RSVP needed: RSVP: Book club/.test(t)) && icsAll.some((t) => /^All day: Today: Bin day/.test(t)) && icsAll.some((t) => /^First meeting|^Next up/.test(t)), icsAll);
  await save(page, 'ics');

  // 5g. Reminders
  await openTile(page, 'manual');
  await page.fill(`${panel('manual')} input[aria-label="Reminder"]`, 'Take vitamins');
  await page.selectOption(`${panel('manual')} select[aria-label="Repeat"]`, 'daily');
  await page.click(`${panel('manual')} .f-btn:has-text("+ Add reminder")`); await sleep(400);
  await save(page, 'manual');
  await page.click('[data-act="wiz-next"]'); await sleep(300);
  const doneTxt = await page.$eval('.mdf-wizard', (n) => n.innerText);
  ok('wizardDone', /Your deck is ready/.test(doneTxt) && /stays on this phone/.test(doneTxt));
  await page.click('[data-act="wiz-next"]'); await page.waitForSelector('.mdf-wizard', { state: 'detached' });

  // 6. the real deck: sorted by urgency, feedback card last, no sample cards
  await page.waitForFunction(() => window.MorningDeck.state.deck.length > 3 && !window.MorningDeck.state.deck[0].sample, null, { timeout: 30000 }); await sleep(1200);
  d = await kit.deck();
  const rank = { high: 0, normal: 1, low: 2 };
  const sorted = d.slice(0, -1).every((c, i, a) => i === 0 || rank[a[i - 1].priority] <= rank[c.priority]);
  const greet = await page.textContent('#greeting');
  ok('realDeckSorted+feedbackLast', sorted && d[d.length - 1].id.startsWith('morningdeck-feedback-') && !d.some((c) => c.sample) && /, Sam/.test(greet), { greet, deck: d.map((c) => `${c.priority}:${c.service}:${c.title.slice(0, 40)}`) });
  const services = new Set(d.map((c) => c.service));
  ok('deckHasAllConnected', ['weather', 'news', 'todoist', 'github', 'inbox', 'ics', 'manual'].every((s) => services.has(s)), [...services]);
  const manualCard = d.find((c) => c.service === 'manual');
  const manualLabels = await page.evaluate((id) => { const c = window.MorningDeck.state.deck.find((x) => x.id === id); return [c.gestures.right.label, c.gestures.left.label]; }, manualCard.id);
  ok('gestureMeaningsApplied', manualLabels.join('/') === 'Done/Not now', manualLabels);

  // 7. swipes act (opt-in): Todoist close + Undo reopens; GitHub stays record-only
  log.length = 0;
  ok('todoistOnTop', await bringToTop(page, kit, (c) => c.id.startsWith('todoist-t-overdue')));
  await kit.drag(330, 20); await sleep(1500);
  const closed = log.find((l) => /\/tasks\/t-overdue\/close$/.test(l.url) && l.method === 'POST');
  ok('swipeActsTodoistClose', !!closed, log.map((l) => l.method + ' ' + l.url));
  await page.click('#btnUndo'); await sleep(1800);
  ok('undoReopensTodoist', log.some((l) => /\/tasks\/t-overdue\/reopen$/.test(l.url)), log.map((l) => l.method + ' ' + l.url));
  await kit.drag(330, 20); await sleep(800); // close it again for the rest
  log.length = 0;
  if (await bringToTop(page, kit, (c) => c.service === 'github')) { await kit.drag(330, 20); await sleep(800); }
  ok('githubRecordOnly', !log.some((l) => l.url.includes('api.github.com') && l.method !== 'GET'), log.map((l) => l.method + ' ' + l.url));
  // a real weather card on top for the screenshot
  if (await bringToTop(page, kit, (c) => c.service === 'weather')) { await sleep(500); await kit.shot('07-deck-real-weather-card.png'); }
  const recurring = await page.evaluate(() => window.MDF.cacheAll().todoist.cards.find((c) => c.ref.recurring).gestures.right.action || null);
  ok('recurringTaskNotActed', recurring === null, recurring);

  // 8. inbox: an automation posts while the app is open -> new card
  ntfy.publish({ topic, title: 'Washing machine finished', message: 'Time to hang it up', priority: 4, tags: ['house', 'from-home-assistant'] });
  await page.evaluate(() => window.MDF.syncService('inbox', { force: true }).then(() => window.MorningDeck.loadDeck()));
  await sleep(1200);
  d = await kit.deck();
  const wm = d.find((c) => /Washing machine/.test(c.title));
  ok('inboxNewCard', !!wm && wm.priority === 'high' && wm.source === 'Home Assistant', wm);

  // 9. improvement card: reply + photo -> stored locally -> share sheet (navigator.share)
  for (let i = 0; i < 40 && (await kit.deck()).length > 1; i++) { await page.evaluate(() => window.MorningDeck.swipe('down')); await sleep(650); }
  ok('feedbackCardLast', (await kit.topId() || '').startsWith('morningdeck-feedback-'));
  await kit.tripleTap(); await page.waitForSelector('#sheetWrap:not([hidden])'); await sleep(500);
  await page.fill('#replyText', 'Please add a dark theme for the settings');
  await page.setInputFiles('#photoInput', photoPath); await sleep(1500);
  await page.click('#sheetSave');
  await page.waitForSelector('.mdf-dialog [data-act="fb-share"]', { timeout: 8000 });
  const fbDialog = await page.$eval('.mdf-dialog', (n) => n.innerText);
  ok('feedbackShareDialog', /Share it with the person who shared this app\?/.test(fbDialog) && /dark theme/.test(fbDialog) && /1 photo/.test(fbDialog), fbDialog.slice(0, 200));
  await page.click('.mdf-dialog [data-act="fb-share"]'); await sleep(600);
  const shares = await page.evaluate(() => window.__shares);
  ok('feedbackSharedViaShareSheet', shares.length === 1 && /dark theme/.test(shares[0].text) && shares[0].files.length === 1, shares);
  const fbStored = await page.evaluate(() => window.MDF.ls.get('feedback', []));
  ok('feedbackStoredLocally', fbStored.length === 1 && /dark theme/.test(fbStored[0].text), fbStored);
  await sleep(1500);
  const cleared = await page.evaluate(() => ({ visible: !document.getElementById('cleared').hidden, sub: document.getElementById('clearedSub').textContent }));
  ok('clearedScreen', cleared.visible && /Saved on this phone/.test(cleared.sub), cleared);

  // 10. reload keeps answers (local storage), deck stays cleared except new things
  await page.reload({ waitUntil: 'networkidle' }); await sleep(2500);
  d = await kit.deck();
  ok('answersPersistAcrossReload', d.length === 0 || d.every((c) => !c.id.startsWith('todoist-t-overdue')), d.map((c) => c.id));

  // 11. offline: the service worker serves the shell; cached cards still work
  const swOk = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, controlled: !!navigator.serviceWorker.controller }; });
  ok('serviceWorkerScope', swOk.scope.endsWith('/friends/') && swOk.controlled, swOk);
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(() => {}); await sleep(3000);
  const off = await page.evaluate(() => ({ title: document.title, hasApp: !!document.getElementById('stack'), greeting: document.getElementById('greeting').textContent, loaded: window.MorningDeck && window.MorningDeck.state.loaded }));
  ok('offlineShell', off.hasApp && off.loaded && /Sam/.test(off.greeting), off);
  await ctx.setOffline(false);

  // 12. settings: screenshot, export (with/without secrets), reset, import
  await page.click('#settingsBtn'); await page.waitForSelector('.mdf-settings.shown'); await sleep(400);
  const svcRows = await page.$$eval('.mdf-svclist li[data-svc]', (ns) => ns.map((n) => n.dataset.svc));
  ok('settingsListsServices', svcRows.length === 7, svcRows);
  await kit.shot('08-settings.png');
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="export"]')]);
  const exp1 = JSON.parse(fs.readFileSync(await dl1.path(), 'utf8'));
  ok('exportWithoutSecrets', exp1.app === 'morning-deck-friends' && exp1.settings.services.todoist.cfg.token === '' && exp1.settings.services.inbox.cfg.topic === '' && !JSON.stringify(exp1).includes('0123456789abcdef0123456789abcdef01234567'), Object.keys(exp1.settings.services));
  await page.check('#exportSecrets');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="export"]')]);
  const expPath = path.join(os.tmpdir(), 'mdf-export.json'); fs.copyFileSync(await dl2.path(), expPath);
  const exp2 = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  ok('exportWithSecrets', exp2.settings.services.todoist.cfg.token.length === 40 && exp2.answers.length > 5, { answers: exp2.answers.length });
  page.once('dialog', (dlg) => dlg.accept());
  await page.click('[data-act="reset"]'); await page.waitForLoadState('load'); await sleep(2000);
  const afterReset = await page.evaluate(() => ({ keys: Object.keys(localStorage).filter((k) => k.startsWith('mdf.')).filter((k) => k !== 'mdf.v1.seen'), landing: !!document.querySelector('.mdf-landing') }));
  ok('resetErasesEverything', afterReset.keys.length === 0 && afterReset.landing, afterReset);
  await page.click('#landingTry'); await sleep(800);
  await page.click('#settingsBtn'); await page.waitForSelector('.mdf-settings.shown');
  await page.setInputFiles('#importFile', expPath); await sleep(2500);
  const afterImport = await page.evaluate(() => ({ setup: window.MDF.settings().setupDone, n: Object.keys(window.MDF.settings().services).length, name: window.MDF.settings().name }));
  ok('importRestores', afterImport.setup && afterImport.n === 7 && afterImport.name === 'Sam', afterImport);
  ok('noUnexpectedConsoleErrorsA', kit.unexpected().length === 0, kit.unexpected());
  await ctx.close();

  // ===================== B: owner configured Google + Microsoft client IDs =====================
  const ctxB = await browser.newContext({ ...DEVICE });
  const logB = []; await mocks.install(ctxB, logB);
  await ctxB.addInitScript(() => {
    window.MD_FRIENDS_CONFIG = { googleClientId: '1234567890-test.apps.googleusercontent.com', microsoftClientId: '00000000-0000-4000-8000-000000000000' };
    if (!localStorage.getItem('mdf.v1.settings')) { localStorage.setItem('mdf.v1.seen', 'true'); localStorage.setItem('mdf.v1.settings', JSON.stringify({ version: 1, setupDone: true, name: '', deckTime: '06:00', gestures: { preset: 'yesno', right: 'Yes', left: 'No' }, services: {}, manual: [] })); }
  });
  const pb = await ctxB.newPage(); const kb = pageKit(pb, ctxB);
  await pb.goto(BASE, { waitUntil: 'networkidle' }); await sleep(1200);
  async function addOauth(id, act) {
    await pb.click('#settingsBtn'); await pb.waitForSelector('.mdf-settings.shown');
    await pb.click('[data-act="add-service"]'); await pb.waitForSelector(`.mdf-overlay .mdf-tile[data-svc="${id}"]`); await sleep(250);
    await openTile(pb, id);
    await pb.click(`${panel(id)} [data-act="signin"]`);
    await pb.waitForFunction((sel) => /Works ✓|failed|said|isn|Couldn/.test((document.querySelector(sel + ' .f-status') || {}).textContent || ''), panel(id), { timeout: 15000 });
    const status = await pb.$eval(`${panel(id)} .f-status`, (n) => n.textContent);
    const pv2 = await previews(pb, id);
    if (act) { await pb.click(`${panel(id)} .mdf-act .mdf-switch`); await pb.waitForFunction((sel) => /can now act/.test(document.querySelector(sel + ' .f-status').textContent), panel(id), { timeout: 8000 }); }
    await save(pb, id);
    await pb.evaluate(() => window.MDF.ui.closeAll()); await sleep(300);
    return { status, pv: pv2 };
  }
  const gcal = await addOauth('gcal', true);
  ok('googleCalendarSignIn+preview', /Works ✓/.test(gcal.status) && gcal.pv.length === 3, gcal);
  const gmail = await addOauth('gmail', true);
  ok('gmailSignIn+preview', /Works ✓ · 1 card/.test(gmail.status) && /Your order is on its way/.test(gmail.pv[0].title), gmail);
  const gtasks = await addOauth('gtasks', false);
  ok('googleTasks', /Works ✓ · 1 card/.test(gtasks.status), gtasks);
  const gisScopes = await pb.evaluate(() => window.__gisCalls || []);
  ok('googleScopesReadOnlyFirst', /calendar\.readonly/.test(gisScopes[0]) && !/calendar\.events/.test(gisScopes[0]) && gisScopes.some((s) => /calendar\.events/.test(s)) && gisScopes.some((s) => /gmail\.modify/.test(s)), gisScopes);
  const outlook = await addOauth('outlook', true);
  ok('outlookMail', /Works ✓ · 1 card/.test(outlook.status) && /Contract/.test(outlook.pv[0].title), outlook);
  const mscal = await addOauth('mscal', false);
  ok('outlookCalendar', /Works ✓/.test(mscal.status) && mscal.pv.length >= 2, mscal);
  const mstodo = await addOauth('mstodo', false);
  ok('microsoftToDo', /Works ✓ · 1 card/.test(mstodo.status) && /Pay rent/.test(mstodo.pv[0].title), mstodo);
  const msalCfg = await pb.evaluate(() => ({ auth: window.__msalConfig.auth, calls: window.__msalCalls }));
  ok('msalConfig', msalCfg.auth.authority === 'https://login.microsoftonline.com/common' && /\/friends\/auth\/ms-redirect\.html$/.test(msalCfg.auth.redirectUri) && /Mail\.Read/.test(msalCfg.calls[0]) && msalCfg.calls.some((c) => /Mail\.ReadWrite/.test(c)), msalCfg);
  await pb.evaluate(() => window.MorningDeck.loadDeck({ initial: true })); await sleep(1500);
  // RSVP via swipe (act on): PATCH with sendUpdates=none, Undo restores needsAction
  logB.length = 0;
  ok('rsvpOnTop', await bringToTop(pb, kb, (c) => c.id.startsWith('gcal-rsvp-')));
  await kb.drag(330, 20); await sleep(1500);
  const patch = logB.find((l) => l.method === 'PATCH' && /events\/evC\?sendUpdates=none/.test(l.url));
  ok('rsvpAcceptNoEmail', !!patch && /"self":true,"responseStatus":"accepted"/.test(patch.body), patch && patch.body);
  await pb.click('#btnUndo'); await sleep(2000);
  const back = logB.filter((l) => l.method === 'PATCH').pop();
  ok('rsvpUndo', back && /"responseStatus":"needsAction"/.test(back.body), back && back.body);
  logB.length = 0;
  ok('gmailOnTop', await bringToTop(pb, kb, (c) => c.service === 'gmail'));
  await kb.drag(330, 20); await sleep(1200);
  ok('gmailArchive', logB.some((l) => /messages\/m1\/modify/.test(l.url) && /"removeLabelIds":\["INBOX","UNREAD"\]/.test(l.body)), logB.map((l) => l.method + ' ' + l.url));
  await pb.click('#btnUndo'); await sleep(1500);
  ok('gmailUndo', logB.some((l) => /messages\/m1\/modify/.test(l.url) && /addLabelIds/.test(l.body)));
  // Google tasks act is OFF -> record only
  logB.length = 0;
  if (await bringToTop(pb, kb, (c) => c.service === 'gtasks')) { await kb.drag(330, 20); await sleep(1000); }
  ok('actOffRecordOnly', !logB.some((l) => l.method !== 'GET'), logB.map((l) => l.method + ' ' + l.url));
  // expired Google token -> sign-in refresh card -> dialog -> refresh
  await pb.evaluate(() => { const t = window.MDF.ls.get('auth.google'); t.expires_at = Date.now() - 1000; window.MDF.ls.set('auth.google', t); window.MDF.ls.del('cache'); window.MDF.ls.set('states', {}); });
  await pb.evaluate(() => window.MorningDeck.loadDeck({ initial: true })); await sleep(1500);
  d = await kb.deck();
  ok('reauthCard', d[0] && /^reauth-google-/.test(d[0].id), d.slice(0, 3));
  await kb.drag(330, 20); await pb.waitForSelector('[data-act="reauth-go"]', { timeout: 6000 });
  await pb.click('[data-act="reauth-go"]'); await sleep(2500);
  d = await kb.deck();
  ok('reauthRefreshes', d.some((c) => c.service === 'gcal') && !d.some((c) => /^reauth-google/.test(c.id)), d.map((c) => c.id).slice(0, 8));
  ok('noUnexpectedConsoleErrorsB', kb.unexpected().length === 0, kb.unexpected());
  await ctxB.close();
  await browser.close();

  // ===================== C: installability (persistent profile; incognito never passes) =====================
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdf-prof-'));
  const pctx = await chromium.launchPersistentContext(prof, { executablePath: CHROME, ...DEVICE, args: ['--no-sandbox', '--bypass-app-banner-engagement-checks'] });
  const pp = pctx.pages()[0] || (await pctx.newPage());
  await pp.goto(BASE, { waitUntil: 'networkidle' });
  await pp.evaluate(() => navigator.serviceWorker.ready); await pp.reload({ waitUntil: 'networkidle' }); await sleep(4500);
  const pc = await pctx.newCDPSession(pp);
  const inst = await pc.send('Page.getInstallabilityErrors');
  const man = await pc.send('Page.getAppManifest');
  const bip = await pp.evaluate(() => ({ fired: window.MorningDeck.install.bipFired, mode: document.getElementById('installBtn').dataset.mode, hidden: document.getElementById('installBtn').hidden }));
  const manifest = JSON.parse(man.data || '{}');
  ok('installable', inst.installabilityErrors.length === 0, inst.installabilityErrors);
  ok('manifestIdScope', manifest.id === '/morning-deck/friends/' && manifest.scope === '/morning-deck/friends/' && manifest.start_url === '/morning-deck/friends/?source=pwa', { id: manifest.id, scope: manifest.scope, start: manifest.start_url, url: man.url });
  ok('installPill', bip.fired && bip.mode === 'prompt' && !bip.hidden, bip);
  await pctx.close(); fs.rmSync(prof, { recursive: true, force: true });

  const allOk = Object.values(checks).every((c) => c.ok);
  const fails = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
  console.log(`\n${Object.keys(checks).length - fails.length}/${Object.keys(checks).length} checks passed${fails.length ? ' · FAILED: ' + fails.join(', ') : ''}`);
  fs.writeFileSync(path.join(os.tmpdir(), 'mdf-friends-results.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), allOk, checks }, null, 2));
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
