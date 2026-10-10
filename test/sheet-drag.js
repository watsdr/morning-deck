#!/usr/bin/env node
// Swipe-down-to-dismiss on every bottom sheet: run via `node test/isolated.js test/sheet-drag.js` (never the live port).
// Real touch input (CDP Input.dispatchTouchEvent) on a Pixel-sized touch viewport: long drag closes, short drag springs
// back, a fast flick closes, the sheet follows the finger, scrolled content scrolls instead of dragging, and the backdrop
// tap / Cancel / Escape / text box still behave. Then the same for the install help sheet.
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE;
if (!BASE || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via: node test/isolated.js test/sheet-drag.js'); process.exit(2); }
const results = []; const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, info === undefined ? '' : JSON.stringify(info)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  // drag from (x,y) down by dy over `steps` moves, `stepMs` apart; returns translateY samples seen mid-drag
  const drag = async (x, y, dy, steps = 12, stepMs = 16) => {
    const seen = [];
    await touch('touchStart', x, y);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x, y + (dy * i) / steps); await sleep(stepMs);
      if (i === Math.round(steps / 2)) seen.push(await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('#sheet')).transform).m42));
    }
    await touch('touchEnd'); return seen;
  };
  const isOpen = () => page.evaluate(() => !!window.MorningDeck?.state?.sheetCard || !document.querySelector('#sheetWrap').hidden);
  const sheetOpen = () => page.evaluate(() => !document.querySelector('#sheetWrap').hidden && !document.querySelector('#sheetWrap').classList.contains('closing'));
  const grab = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  const open = async () => { await page.keyboard.press('Enter'); await page.waitForSelector('#sheetWrap:not([hidden])'); await sleep(650); };

  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"]');

  // 1) long drag from the handle closes
  await open();
  const h = await page.evaluate(() => document.querySelector('#sheet').offsetHeight);
  let g = await grab('#sheet .grabber');
  const mid = await drag(g.x, g.y, h * 0.45);
  await sleep(450);
  check('drag handle past 25% -> sheet closes', !(await sheetOpen()) && await page.evaluate(() => document.querySelector('#sheetWrap').hidden), { h });
  check('sheet follows the finger mid-drag (transform)', mid[0] > 20, { translateY: mid[0] });

  // 2) short drag springs back
  await open();
  g = await grab('#sheet .grabber');
  await drag(g.x, g.y, h * 0.12);
  await sleep(600);
  const back = await page.evaluate(() => ({ open: !document.querySelector('#sheetWrap').hidden, ty: new DOMMatrix(getComputedStyle(document.querySelector('#sheet')).transform).m42, card: !!document.querySelector('#sheetTitle').textContent }));
  check('short drag -> springs back, stays open', back.open && Math.abs(back.ty) < 1, back);

  // 3) fast flick (short distance, high velocity) from the sheet body closes
  const t = await grab('#sheetTitle');
  await page.evaluate(() => { document.querySelector('#sheetScroll').scrollTop = 0; });
  await drag(t.x, t.y, 90, 3, 0);
  await sleep(450);
  check('fast flick from content at scrollTop 0 -> closes', await page.evaluate(() => document.querySelector('#sheetWrap').hidden));

  // 4) content scrolled: dragging down in the content scrolls, it does not move the sheet
  await open();
  await page.evaluate(() => { const d = document.querySelector('#sheetDetails'); d.textContent = 'line\n'.repeat(200); document.querySelector('#sheetScroll').scrollTop = 400; });
  const s0 = await page.evaluate(() => document.querySelector('#sheetScroll').scrollTop);
  const d = await grab('#sheetScroll');
  const midS = await drag(d.x, d.y, h * 0.4);
  await sleep(500);
  const s1 = await page.evaluate(() => ({ open: !document.querySelector('#sheetWrap').hidden, top: document.querySelector('#sheetScroll').scrollTop }));
  check('scrolled content: drag scrolls, sheet stays put', s1.open && s1.top < s0 && Math.abs(midS[0]) < 1, { s0, ...s1, ty: midS[0] });

  // 5) existing behaviour: text box focus, Cancel, backdrop tap, Escape
  await page.tap('#replyText'); await sleep(200);
  check('tapping the text box still focuses it (no drag)', await page.evaluate(() => document.activeElement.id === 'replyText' && !document.querySelector('#sheetWrap').hidden));
  await page.tap('#sheetCancel'); await sleep(450);
  check('Cancel still closes', await page.evaluate(() => document.querySelector('#sheetWrap').hidden));
  await open(); await page.touchscreen.tap(206, 40); await sleep(450);
  check('backdrop tap still closes', await page.evaluate(() => document.querySelector('#sheetWrap').hidden));
  await open(); await page.keyboard.press('Escape'); await sleep(450);
  check('Escape still closes', await page.evaluate(() => document.querySelector('#sheetWrap').hidden));
  await open();
  if (await page.isVisible('#photoBtn')) { // photos are off in the static demo
    const chooser = page.waitForEvent('filechooser', { timeout: 2000 }).then(() => true).catch(() => false);
    await page.tap('#photoBtn');
    check('photo picker still opens', await chooser);
  } else console.log('SKIP photo picker (uploads off here)');
  await page.keyboard.press('Escape'); await sleep(450);

  // 6) install help sheet: short drag springs back, long drag closes
  await sleep(4200);
  const pill = await page.evaluate(() => !document.querySelector('#installBtn').hidden);
  if (pill) await page.tap('#installBtn'); else await page.evaluate(() => { document.querySelector('#installWrap').hidden = false; });
  await sleep(500);
  g = await grab('.install-sheet .grabber');
  const ih = await page.evaluate(() => document.querySelector('.install-sheet').offsetHeight);
  await drag(g.x, g.y, ih * 0.1); await sleep(600);
  check('install sheet: short drag springs back', await page.evaluate(() => !document.querySelector('#installWrap').hidden && Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.install-sheet')).transform).m42) < 1));
  await drag(g.x, g.y, ih * 0.5); await sleep(300);
  check('install sheet: long drag closes', await page.evaluate(() => document.querySelector('#installWrap').hidden));
  if (pill) { await page.tap('#installBtn'); await sleep(400); }
  else await page.evaluate(() => { document.querySelector('#installWrap').hidden = false; });
  check('install sheet reopens reset (no leftover transform)', await page.evaluate(() => !document.querySelector('#installWrap').hidden && !document.querySelector('.install-sheet').style.transform));

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  const fail = results.filter((x) => !x).length;
  console.log(`${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
