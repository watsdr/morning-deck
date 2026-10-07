#!/usr/bin/env node
// Install flow check: run via `node test/isolated.js test/install.js` (never against the live port).
// 1) real beforeinstallprompt in Chrome (engagement checks bypassed), 2) simulated prompt -> pill -> prompt() -> accepted,
// 3) no prompt within 4s -> small "Install" -> help sheet, 4) standalone -> no button, 5) /api/diag lines,
// 6) SW update: a temp COPY of the app gets a new sw.js VERSION; the open page must reload itself onto the new shell.
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE;
if (!BASE || new URL(BASE).port === String(env.MD_PORT || 8787) || !process.env.MD_DIAG_LOG) { console.error('run via: node test/isolated.js test/install.js'); process.exit(2); }
const SHOTS = path.join(ROOT, 'screenshots');
const results = []; const check = (name, ok, info) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, info === undefined ? '' : JSON.stringify(info)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const btnInfo = (page) => page.evaluate(() => { const b = document.querySelector('#installBtn'); const r = b.getBoundingClientRect(); return { hidden: b.hidden, mode: b.dataset.mode || null, text: b.textContent.trim(), w: Math.round(r.width), right: Math.round(r.right), vw: innerWidth }; });

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--bypass-app-banner-engagement-checks'] });
  const newPage = async (init) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
    return { ctx, page };
  };

  // 1) real beforeinstallprompt: needs a persistent (non-incognito) profile; Playwright's newContext() counts as incognito
  {
    const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'md-prof-')), { executablePath: '/usr/bin/google-chrome', headless: true,
      args: ['--no-sandbox', '--bypass-app-banner-engagement-checks'], viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });
    await ctx.addInitScript(() => { window.__bip = 0; window.addEventListener('beforeinstallprompt', () => { window.__bip++; }); });
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
    let real = false; for (let i = 0; i < 40 && !real; i++) { real = await page.evaluate(() => window.__bip > 0); if (!real) await sleep(250); }
    const b = await btnInfo(page);
    check('realBeforeInstallPrompt -> "Install app" pill', real && !b.hidden && b.mode === 'prompt' && b.text === 'Install app', { bipFired: real, ...b });
    await page.screenshot({ path: path.join(SHOTS, '16-install-pill.png') });
    await ctx.close();
  }
  // 2) simulated prompt (deterministic): pill, preventDefault, prompt(), accepted, appinstalled
  {
    const { ctx, page } = await newPage(() => { window.addEventListener('beforeinstallprompt', (e) => { if (!e.__fake) e.stopImmediatePropagation(); }, true); });
    const prevented = await page.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.__fake = true;
      e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; return Promise.resolve(); }; e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
      window.dispatchEvent(e); return e.defaultPrevented; });
    const b = await btnInfo(page);
    check('simulatedPrompt: preventDefault + pill next to badge', prevented && !b.hidden && b.mode === 'prompt' && b.right <= b.vw, { prevented, ...b });
    await page.click('#installBtn'); await sleep(300);
    const after = await page.evaluate(() => ({ prompted: window.__prompted || 0, hidden: document.querySelector('#installBtn').hidden, toast: document.querySelector('#toast').textContent }));
    check('click -> prompt() -> accepted hides pill', after.prompted === 1 && after.hidden, after);
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled'))); await sleep(4300);
    check('appinstalled keeps it hidden (no fallback after 4s)', (await btnInfo(page)).hidden);
    await ctx.close();
  }
  // 2b) dismissed prompt -> falls back to the help button
  {
    const { ctx, page } = await newPage(() => { window.addEventListener('beforeinstallprompt', (e) => { if (!e.__fake) e.stopImmediatePropagation(); }, true); });
    await page.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.__fake = true; e.prompt = () => Promise.resolve(); e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); });
    await page.click('#installBtn'); await sleep(300);
    const b = await btnInfo(page);
    check('dismissed -> small "Install" help button', !b.hidden && b.mode === 'help' && b.text === 'Install', b);
    await ctx.close();
  }
  // 3) no prompt at all -> after ~4s small Install -> help sheet
  {
    const { ctx, page } = await newPage(() => { window.addEventListener('beforeinstallprompt', (e) => e.stopImmediatePropagation(), true); });
    const early = await btnInfo(page);
    await sleep(4400);
    const b = await btnInfo(page);
    check('noPrompt: hidden at first, small "Install" after 4s', early.hidden && !b.hidden && b.mode === 'help' && b.text === 'Install', { early: early.hidden, ...b });
    await page.click('#installBtn'); await sleep(500);
    const sheet = await page.evaluate(() => ({ open: !document.querySelector('#installWrap').hidden, title: document.querySelector('#installTitle').textContent, steps: [...document.querySelectorAll('.install-steps li')].map((li) => li.textContent.trim()) }));
    check('help sheet with 3 Android Chrome steps', sheet.open && sheet.steps.length === 3 && /address bar/.test(sheet.steps[0]) && /Install and create shortcut/.test(sheet.steps[1]) && /Share/.test(sheet.steps[2]), sheet);
    await page.screenshot({ path: path.join(SHOTS, '17-install-help.png') });
    await page.click('#installDone'); await sleep(200);
    check('"Got it" closes the sheet', await page.evaluate(() => document.querySelector('#installWrap').hidden));
    await ctx.close();
  }
  // 4) standalone -> nothing shown even if a prompt fires
  {
    const { ctx, page } = await newPage(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => /display-mode:\s*standalone/.test(q) ? ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }) : mm(q); });
    await page.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => Promise.resolve(); e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
    await sleep(4400);
    check('standalone: no install button', (await btnInfo(page)).hidden);
    await ctx.close();
  }
  // 5) diagnostics log
  {
    const lines = fs.readFileSync(process.env.MD_DIAG_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const allowed = new Set(['at', 'ua', 'displayMode', 'bipFired', 'swControlled', 'standalone', 'ts', 'event', 'outcome', 'installed', 'path', 'via']);
    const ev = lines.map((l) => `${l.event}${l.outcome ? ':' + l.outcome : ''}`);
    const types = lines.every((l) => typeof l.ua === 'string' && typeof l.bipFired === 'boolean' && typeof l.swControlled === 'boolean' && typeof l.standalone === 'boolean' && typeof l.displayMode === 'string' && l.ts);
    check('diag.log lines (fields + events)', types && lines.every((l) => Object.keys(l).every((k) => allowed.has(k))) && ev.includes('load') && ev.includes('prompt:accepted') && ev.includes('prompt:dismissed') && ev.includes('appinstalled') && ev.includes('help-opened'), { count: lines.length, events: ev, sample: lines.find((l) => l.event === 'load') });
    const unauth = await fetch(BASE + '/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ua":"x"}' });
    check('/api/diag requires auth', unauth.status === 401, unauth.status);
  }
  await browser.close();

  // 6) SW update on a temp copy of the app (own port, data dir and env file)
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-swupd-'));
    for (const d of ['lib', 'public']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
    for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
    const port = 8798, token = 'swupdate-test-token-' + Date.now();
    fs.writeFileSync(path.join(tmp, '.env'), `MD_TOKEN=${token}\nMD_PORT=${port}\n`);
    const senv = { ...process.env, MD_DATA_DIR: path.join(tmp, 'data'), MD_PORT: String(port), MD_ENV_FILE: path.join(tmp, '.env'), MD_DIAG_LOG: path.join(tmp, 'diag.log'), MD_TOKEN: token };
    fs.mkdirSync(senv.MD_DATA_DIR);
    const srv = spawn(process.execPath, ['server.js'], { cwd: tmp, env: senv, stdio: 'ignore' });
    const SB = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 50; i++) { try { if ((await fetch(SB + '/sw.js')).ok) break; } catch {} await sleep(100); }
      const b2 = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
      const ctx = await b2.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      let navs = 0; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
      await page.goto(`${SB}/?token=${token}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload({ waitUntil: 'networkidle' });
      const v1 = await page.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, caches: await caches.keys() }));
      const before = navs;
      const swp = path.join(tmp, 'public', 'sw.js');
      fs.writeFileSync(swp, fs.readFileSync(swp, 'utf8').replace(/const VERSION = '([^']+)'/, "const VERSION = '$1-next'"));
      await page.evaluate(() => { window.__marker = 1; document.dispatchEvent(new Event('visibilitychange')); }); // triggers reg.update()
      let reloaded = false; for (let i = 0; i < 40 && !reloaded; i++) { await sleep(250); reloaded = navs > before && await page.evaluate(() => window.__marker === undefined).catch(() => false); }
      await page.waitForLoadState('networkidle').catch(() => {});
      const v2 = await page.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, caches: await caches.keys(), cards: document.querySelectorAll('.card[data-id], #cleared:not([hidden])').length }));
      check('SW update: new version claims + page auto-reloads once', v1.controlled && reloaded && v2.controlled && v2.caches.some((k) => k.endsWith('-next-shell')) && !v2.caches.some((k) => v1.caches.includes(k)) && navs - before === 1, { before: v1.caches, after: v2.caches, reloads: navs - before });
      await b2.close();
    } finally { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  const filtered = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Banner not shown/.test(e));
  check('no console errors', filtered.length === 0, filtered);
  const allOk = results.every((r) => r.ok);
  console.log('allOk', allOk);
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
