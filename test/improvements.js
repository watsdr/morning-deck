// Oct 12 improvements: toast Undo action, age/expiry chips, instant offline banner, labelled answer buttons.
// Usage: node test/isolated.js test/improvements.js   (temp data dir + port 8799, SAMPLE deck)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE;
if (!BASE || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
const api = async (p, opts = {}) => (await fetch(BASE + p, { ...opts, headers: { Authorization: `Bearer ${env.MD_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
(async () => {
  const now = Date.now();
  await api('/api/cards', { method: 'POST', body: JSON.stringify([
    { id: 'test-old', source: 'Test bot', title: 'TEST old card', createdAt: new Date(now - 3 * 86400e3).toISOString(), priority: 'high' },
    { id: 'test-due', source: 'Test bot', title: 'TEST due card', expiresAt: new Date(now + 3 * 3600e3).toISOString(), priority: 'high' },
  ]) });
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"][data-id]'); await sleep(800);
  const chips = await page.$$eval('.card', (ns) => Object.fromEntries(ns.map((n) => [n.dataset.id, [...n.querySelectorAll('.chip-stale,.chip-due')].map((c) => c.textContent)])));
  ok(chips['test-old'] && chips['test-old'][0] === 'Waiting 3 days', `stale chip: ${JSON.stringify(chips['test-old'])}`);
  ok(chips['test-due'] && /^Expires in [23]h$/.test(chips['test-due'][0]), `expiry chip: ${JSON.stringify(chips['test-due'])}`);
  const fresh = Object.entries(chips).filter(([id, c]) => !id.startsWith('test-') && c.length).length;
  ok(fresh === 0, 'fresh cards get no age chip');
  const top = await page.$eval('.card[data-depth="0"]:not(.flying)', (n) => ({ id: n.dataset.id, title: n.querySelector('h2').textContent }));
  const aria = await page.$eval('.act[data-g="right"]', (b) => b.getAttribute('aria-label'));
  ok(aria.endsWith(`: ${top.title}`), `Yes button label: ${aria}`);
  ok(await page.$$eval('.actions svg', (s) => s.every((x) => x.getAttribute('aria-hidden') === 'true')), 'button icons hidden from screen readers');
  // swipe via button, then undo from the toast
  await page.click('.act[data-g="right"]'); await sleep(900);
  ok(await page.isVisible('.toast.show .toast-act'), 'answer toast shows an Undo button');
  await sleep(300);
  let ans = await api('/api/answers'); ok(ans.answers.some((a) => a.cardId === top.id), 'answer recorded');
  await page.click('.toast .toast-act'); await sleep(1200);
  const back = await page.$eval('.card[data-depth="0"]:not(.flying)', (n) => n.dataset.id);
  ok(back === top.id, 'toast Undo brings the card back');
  ans = await api('/api/answers'); ok(!ans.answers.some((a) => a.cardId === top.id), 'server answer undone');
  ok(await page.$eval('.toast', (t) => getComputedStyle(t).pointerEvents) === 'none' || !(await page.isVisible('.toast.show')), 'hidden toast does not block taps');
  // offline banner
  await ctx.setOffline(true); await sleep(300);
  const pill = await page.$eval('#statusPill', (p) => (p.hidden ? '' : p.textContent));
  ok(pill.startsWith('Offline · keep swiping'), `offline banner: ${pill}`);
  await page.click('.act[data-g="down"]'); await sleep(1200);
  await ctx.setOffline(false); await sleep(2500);
  ans = await api('/api/answers'); ok(ans.answers.some((a) => a.cardId === top.id && a.gesture === 'down'), 'offline answer synced on reconnect');
  ok(await page.$eval('#statusPill', (p) => p.hidden), 'banner cleared after sync');
  ok(!errs.length, `no page errors ${errs.join('; ')}`);
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
