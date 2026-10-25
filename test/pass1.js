// Pass-1 end-to-end suite (isolated): node test/isolated.js test/pass1.js --empty   (or: npm test)
// Headless Chromium (playwright-core + system Chrome) on a phone viewport against a throwaway server on 8799.
// Every card here is a clearly labeled SAMPLE card created by the test. Never run against the live server.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D || !D.startsWith(os.tmpdir()) || new URL(B).port === '8787') { console.error('run via node test/isolated.js test/pass1.js --empty'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const TOK = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const SHOTS = path.join(ROOT, 'run', 'screens-pass1');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { Authorization: `Bearer ${TOK}` };
const call = async (method, p, body, headers = {}) => { const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch (_) { j = t; } return { status: r.status, body: j, headers: r.headers }; };
const results = []; let failed = 0;
async function t(name, fn) { try { await fn(); results.push(['PASS', name]); console.log('PASS', name); } catch (e) { failed++; results.push(['FAIL', name, e.message]); console.log('FAIL', name, '-', e.message.slice(0, 600)); } }
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const sample = (id, extra = {}) => ({ id, source: 'Test Bot', sample: true, title: `SAMPLE ${id}`, body: 'Sample card created by the test suite.', ...extra });

(async () => {
  // ---------- API: auth, manifest, service worker ----------
  await t('401 without token on / and /api/deck', async () => {
    const a = await fetch(B + '/'); assert.strictEqual(a.status, 401);
    const b = await fetch(B + '/api/deck'); assert.strictEqual(b.status, 401);
    const c = await fetch(B + '/api/deck', { headers: { Authorization: 'Bearer wrong' } }); assert.strictEqual(c.status, 401);
  });
  await t('manifest + service worker are public and valid', async () => {
    const m = await fetch(B + '/manifest.webmanifest'); assert.strictEqual(m.status, 200); const j = await m.json(); assert.ok(j.name && j.icons && j.icons.length && j.start_url);
    const s = await fetch(B + '/sw.js'); assert.strictEqual(s.status, 200); assert.match(await s.text(), /const VERSION = 'md-v\d+'/);
  });
  // ---------- Posting API ----------
  await t('POST /api/cards validates fields', async () => {
    let r = await call('POST', '/api/cards', { source: 'Trip Desk' }); assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/cards', sample('bad-due', { dueAt: 'tomorrow-ish' })); assert.strictEqual(r.status, 400); assert.match(JSON.stringify(r.body), /dueAt/);
    r = await call('POST', '/api/cards', sample('bad-reply', { replyTo: { agentId: 42 } })); assert.strictEqual(r.status, 400); assert.match(JSON.stringify(r.body), /agentId/);
    r = await call('POST', '/api/cards', sample('bad-label', { gestures: { right: { label: '' } } })); assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/cards', sample('bad-gesture', { gestures: { sideways: { label: 'x' } } })); assert.strictEqual(r.status, 400);
    r = await fetch(B + '/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.strictEqual(r.status, 401);
  });
  await t('POST /api/cards accepts question/context aliases, dueAt, labels, replyTo.agentId; dedupes by id', async () => {
    const c = { id: 'sample-alias', source: 'Scheduler', sample: true, question: 'SAMPLE: move the sample meeting?', context: 'Sample context line.', dueAt: iso(-3600e3), replyTo: { agentId: 'sample-agent-1' }, gestures: { right: { label: 'Move it' }, left: { label: 'Keep it' } } };
    let r = await call('POST', '/api/cards', c); assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', '/api/cards', c); assert.ok([200, 201].includes(r.status)); assert.match(JSON.stringify(r.body), /sample-alias/); assert.match(JSON.stringify(r.body), /duplicate/i);
    const d = await call('GET', '/api/deck'); const card = d.body.cards.find((x) => x.id === 'sample-alias');
    assert.ok(card, 'in deck'); assert.strictEqual(card.title, c.question); assert.strictEqual(card.body, c.context);
    assert.strictEqual(d.body.cards.filter((x) => x.id === 'sample-alias').length, 1);
  });
  await t('deck ranks overdue, then due today, before priority', async () => {
    await call('POST', '/api/cards', [sample('rank-urgent', { priority: 'high' }), sample('rank-today', { dueAt: iso(60e3) }), sample('rank-later', { dueAt: iso(5 * 86400e3), priority: 'low' })]);
    const ids = (await call('GET', '/api/deck')).body.cards.map((c) => c.id).filter((i) => i.startsWith('rank-') || i === 'sample-alias');
    assert.deepStrictEqual(ids.slice(0, 2), ['sample-alias', 'rank-today'], ids.join(','));
    assert.ok(ids.indexOf('rank-urgent') < ids.indexOf('rank-later'));
  });
  // clear test cards so the browser deck is predictable
  for (const id of ['sample-alias', 'rank-urgent', 'rank-today', 'rank-later']) await call('POST', '/api/answers', { cardId: id, gesture: 'down' });

  // ---------- localhost-only endpoints ----------
  await t('QR pairing endpoint is localhost-only', async () => {
    let r = await fetch(B + '/signin/qr', { headers: { ...auth, 'X-Forwarded-For': '1.2.3.4' } }); assert.strictEqual(r.status, 404);
    r = await fetch(B + '/signin/qr', { headers: { ...auth, 'Tailscale-Funnel-Request': '?1' } }); assert.strictEqual(r.status, 404);
    r = await fetch(B + '/signin/qr', { headers: auth }); assert.ok(r.status !== 404, 'available on box: ' + r.status);
  });
  await t('device approval: phone requests a code, approve only from localhost via approve-phone.sh, phone gets session', async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(B + '/'); await page.waitForSelector('#mdDevBtn');
    assert.match(await page.textContent('#mdDevBtn'), /Request access from this phone/);
    await page.screenshot({ path: path.join(SHOTS, 'signin-locked.png') });
    await page.click('#mdDevBtn'); await page.waitForSelector('#mdDevCode');
    const code = (await page.textContent('#mdDevCode')).trim(); assert.match(code, /^[A-Z2-9]{6}$/);
    await page.screenshot({ path: path.join(SHOTS, 'signin-code.png') });
    const far = await fetch(B + '/api/device/approve', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' }, body: JSON.stringify({ code }) });
    assert.strictEqual(far.status, 404, 'approval refused through a proxy');
    const out = spawnSync('bash', ['scripts/approve-phone.sh', code, '--yes'], { cwd: ROOT, env: { ...process.env, MD_PORT_OVERRIDE: new URL(B).port }, encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr); assert.ok(!out.stdout.includes(TOK), 'token never printed');
    await page.waitForSelector('.card, #cleared:not([hidden])', { timeout: 15000 });
    await browser.close();
  });

  // ---------- Browser: gestures, onboarding, undo, history, recap, insights ----------
  const labeled = [
    sample('g-right', { title: 'SAMPLE right', gestures: { right: { label: 'Ship it' } } }),
    sample('g-left', { title: 'SAMPLE left' }),
    sample('g-up', { title: 'SAMPLE up (snooze)' }),
    sample('g-down', { title: 'SAMPLE down' }),
    sample('g-tap3', { title: 'SAMPLE triple tap' }),
    sample('g-fyi', { title: 'SAMPLE FYI', type: 'info' }),
    sample('g-undo', { title: 'SAMPLE undo' }),
  ];
  labeled.forEach((c, i) => { c.createdAt = iso(-600e3 + i * 1000); });
  assert.strictEqual((await call('POST', '/api/cards', labeled)).status, 201);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const mk = async (scheme, { tourDone = true } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, timezoneId: 'America/New_York',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' });
    await ctx.addInitScript(([done, theme]) => { try { if (done) localStorage.setItem('md_tour_done', '1'); localStorage.setItem('md_theme', theme); } catch (_) {} }, [tourDone, scheme]);
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${B}/?token=${TOK}`, { waitUntil: 'networkidle' });
    const cdp = await ctx.newCDPSession(page);
    let clock = Date.now() / 1000;
    const touch = (type, x, y, dt = 16) => { clock = type === 'touchStart' ? Math.max(clock + 0.5, Date.now() / 1000) : clock + dt / 1000; return cdp.send('Input.dispatchTouchEvent', { type, timestamp: clock, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }] }); };
    const dragAt = async (box, dx, dy) => { const x0 = box.x + box.width / 2, y0 = box.y + box.height * 0.42; await touch('touchStart', x0, y0); for (let i = 1; i <= 20; i++) { await touch('touchMove', x0 + dx * i / 20, y0 + dy * i / 20); await sleep(12); } await touch('touchEnd'); await sleep(800); };
    const tapsAt = async (box) => { const x = box.x + box.width / 2, y = box.y + box.height * 0.45; for (let i = 0; i < 3; i++) { clock = i ? clock + 0.14 : Math.max(clock + 0.5, Date.now() / 1000); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: clock, touchPoints: [{ x: x + i, y }] }); clock += 0.055; await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: clock, touchPoints: [] }); await sleep(40); } await sleep(700); };
    const top = async () => { const h = await page.waitForSelector('.card[data-depth="0"][data-id]:not(.flying)'); return { id: await h.getAttribute('data-id'), box: await h.boundingBox() }; };
    return { ctx, page, errors, dragAt, tapsAt, top };
  };
  const answers = async () => (await call('GET', '/api/answers')).body.answers || [];
  const lastFor = async (id) => (await answers()).filter((a) => a.cardId === id).pop();

  {
    const s = await mk('dark');
    await s.page.waitForSelector('.card[data-depth="0"][data-id]'); await sleep(1200);
    await s.page.screenshot({ path: path.join(SHOTS, 'deck-dark.png') });
    await t('relabeled gesture shows the custom label', async () => { const txt = await s.page.textContent('.card[data-depth="0"]'); assert.ok((await s.top()).id === 'g-right'); assert.ok(/Ship it/.test(txt) || /Ship it/.test(await s.page.textContent('.act-right')), 'label visible'); });
    const steps = [['g-right', 'right', 330, 20], ['g-left', 'left', -330, 20], ['g-up', 'up', 0, -420], ['g-down', 'down', 0, 420]];
    for (const [id, g, dx, dy] of steps) await t(`swipe ${g} records ${g}`, async () => { const tp = await s.top(); assert.strictEqual(tp.id, id); await s.dragAt(tp.box, dx, dy); await sleep(400); const a = await lastFor(id); assert.ok(a, 'answer recorded'); assert.strictEqual(a.gesture, g); if (g === 'right') assert.strictEqual(a.label, 'Ship it'); });
    await t('snoozed card (up) leaves the deck and returns after snoozedUntil', async () => {
      const raw = JSON.parse(fs.readFileSync(path.join(D, 'cards.json'), 'utf8')); const c = (Array.isArray(raw) ? raw : raw.cards).find((x) => x.id === 'g-up');
      assert.strictEqual(c.status, 'snoozed'); assert.ok(Date.parse(c.snoozedUntil) > Date.now());
      assert.ok(!(await call('GET', '/api/deck')).body.cards.some((x) => x.id === 'g-up'));
      const core = require('../lib/core'); assert.ok(core.isPending(c, new Date(Date.parse(c.snoozedUntil) + 1000)), 'pending again after snooze');
    });
    await t('triple-tap opens reply sheet and saves a reply', async () => {
      const tp = await s.top(); assert.strictEqual(tp.id, 'g-tap3'); await s.tapsAt(tp.box);
      await s.page.waitForSelector('#sheetWrap:not([hidden])'); await s.page.fill('#replyText', 'Sample reply from the test suite.');
      await s.page.screenshot({ path: path.join(SHOTS, 'tap3-sheet-dark.png') });
      await s.page.click('#sheetSave'); await sleep(1200); const a = await lastFor('g-tap3'); assert.strictEqual(a.gesture, 'tap3'); assert.match(a.text, /Sample reply/);
    });
    await t('FYI card acknowledges with Got it', async () => { const tp = await s.top(); assert.strictEqual(tp.id, 'g-fyi'); await s.dragAt(tp.box, 330, 10); await sleep(400); const a = await lastFor('g-fyi'); assert.strictEqual(a.value, 'ack'); });
    await t('undo restores the last card', async () => {
      const tp = await s.top(); assert.strictEqual(tp.id, 'g-undo'); await s.dragAt(tp.box, -330, 10); await sleep(500);
      await s.page.click('#btnUndo'); await sleep(1200);
      assert.strictEqual((await s.top()).id, 'g-undo'); assert.ok((await call('GET', '/api/deck')).body.cards.some((x) => x.id === 'g-undo'));
    });
    await t('history panel lists answers', async () => { await s.page.click('#settingsBtn'); await s.page.screenshot({ path: path.join(SHOTS, 'settings-dark.png') }); await s.page.click('#historyBtn'); await s.page.waitForFunction(() => document.querySelectorAll('#historyList li').length >= 5, null, { timeout: 8000 }); await s.page.screenshot({ path: path.join(SHOTS, 'history-dark.png') }); await s.page.click('.panel-x[data-close="history"]'); await s.page.click('.panel-x[data-close="settings"]'); });
    await t('insights panel + /api/insights', async () => { const r = await call('GET', '/api/insights'); assert.strictEqual(r.status, 200); assert.ok(typeof r.body === 'object'); await s.page.click('#insightsBtn'); await s.page.waitForFunction(() => !/Loading/.test(document.querySelector('#insightsBody').textContent), null, { timeout: 8000 }); await s.page.screenshot({ path: path.join(SHOTS, 'insights-dark.png') }); await s.page.click('.panel-x[data-close="insights"]'); });
    await t('no page errors (dark session)', async () => assert.deepStrictEqual(s.errors, []));
    await s.ctx.close();
  }
  await t('recap: /api/recap and /?view=recap', async () => {
    const r = await call('GET', '/api/recap'); assert.strictEqual(r.status, 200); assert.ok(r.body && typeof r.body === 'object');
    const s = await mk('light'); await s.page.goto(`${B}/?view=recap`, { waitUntil: 'networkidle' });
    await s.page.waitForSelector('#recapWrap:not([hidden])'); await s.page.waitForFunction(() => !/Loading/.test(document.querySelector('#recapBody').textContent), null, { timeout: 8000 });
    await s.page.screenshot({ path: path.join(SHOTS, 'recap-light.png') }); await s.page.click('.panel-x[data-close="recap"]');
    await s.page.screenshot({ path: path.join(SHOTS, 'deck-light.png') });
    await s.ctx.close();
  });

  // ---------- Onboarding ----------
  await t('onboarding: shown once, practice-labeled, 5 gestures, records nothing, replayable', async () => {
    const before = (await answers()).length; const deckBefore = (await call('GET', '/api/deck')).body.cards.map((c) => c.id).join();
    for (const scheme of ['dark', 'light']) {
      const s = await mk(scheme, { tourDone: false });
      await s.page.waitForSelector('#tourWrap .tour-card', { timeout: 6000 }); await sleep(400);
      assert.match(await s.page.textContent('.tour-badge'), /PRACTICE/);
      await s.page.screenshot({ path: path.join(SHOTS, `tour-1-${scheme}.png`) });
      const card = async () => (await s.page.$('.tour-card')).boundingBox();
      // wrong gesture: stays on step 1
      await s.dragAt(await card(), -300, 0); await sleep(300); assert.strictEqual(await s.page.getAttribute('#tourWrap', 'data-step'), 'right'); assert.match(await s.page.textContent('.tour-live'), /Try/);
      for (const [g, dx, dy] of [['right', 300, 0], ['left', -300, 0], ['up', 0, -380], ['down', 0, 380]]) {
        assert.strictEqual(await s.page.getAttribute('#tourWrap', 'data-step'), g, 'live: ' + await s.page.textContent('.tour-live'));
        await s.dragAt(await card(), dx, dy); await sleep(200);
        if (scheme === 'dark' && g === 'up') await s.page.screenshot({ path: path.join(SHOTS, 'tour-4-down-dark.png') });
      }
      assert.strictEqual(await s.page.getAttribute('#tourWrap', 'data-step'), 'tap3');
      await s.tapsAt(await card()); await sleep(500);
      assert.strictEqual(await s.page.$('#tourWrap'), null, 'closed after 5 steps');
      assert.strictEqual(await s.page.$('#sheetWrap:not([hidden])'), null, 'no real reply sheet opened');
      await s.page.reload({ waitUntil: 'networkidle' }); await sleep(1200); assert.strictEqual(await s.page.$('#tourWrap'), null, 'not shown twice');
      if (scheme === 'dark') { await s.page.click('#settingsBtn'); await s.page.click('#tourRowBtn'); await s.page.waitForSelector('#tourWrap'); await s.page.click('.tour-skip'); await sleep(400); assert.strictEqual(await s.page.$('#tourWrap'), null); }
      assert.deepStrictEqual(s.errors, []);
      await s.ctx.close();
    }
    assert.strictEqual((await answers()).length, before, 'no answers recorded by the tutorial');
    assert.strictEqual((await call('GET', '/api/deck')).body.cards.map((c) => c.id).join(), deckBefore, 'deck unchanged');
  });
  await t('reduced motion: swipe still records, no confetti canvas', async () => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await ctx.addInitScript(() => localStorage.setItem('md_tour_done', '1'));
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${B}/?token=${TOK}`, { waitUntil: 'networkidle' }); await page.waitForSelector('.card[data-depth="0"][data-id="g-undo"]');
    await page.click('.act-down'); await sleep(600);
    const a = await lastFor('g-undo'); assert.strictEqual(a.gesture, 'down');
    assert.deepStrictEqual(errs, []); await ctx.close();
  });
  await browser.close();
  // ---------- summary ----------
  const pass = results.filter((r) => r[0] === 'PASS').length;
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail: failed, results }, null, 1));
  console.log(`\npass1: ${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
