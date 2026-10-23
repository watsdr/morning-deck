// Sign-in recovery: stale/missing cookie, stale ?token (old APK), paste sign-in, rate limit, SW never caches 401s.
// Usage: node test/isolated.js test/signin-recovery.js   (never the live server; the token is never printed)
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TOKEN = env.MD_TOKEN; const BASE = process.env.MD_BASE || '';
if (!BASE || +new URL(BASE).port === +(env.MD_PORT || 8787)) { console.error('run via: node test/isolated.js test/signin-recovery.js'); process.exit(2); }
const SHOTS = path.join(ROOT, 'run', 'screens-signin'); fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0; const check = (n, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${info ? ' — ' + info : ''}`); if (!ok) failed++; };
const STALE = 'stale' + 'x'.repeat(30);
const lockShown = (page) => page.$eval('.md-lock h1', (n) => n.textContent).then((t) => t === 'Sign in again').catch(() => false);
const deckShown = (page) => page.waitForSelector('.card[data-id]', { timeout: 8000 }).then(() => true).catch(() => false);
(async () => {
  // HTTP-level
  let r = await fetch(`${BASE}/api/deck`); check('missing cookie: /api/deck 401', r.status === 401);
  r = await fetch(`${BASE}/api/deck`, { headers: { cookie: 'md_session=' + STALE } }); check('stale cookie: /api/deck 401 + X-MD-Lock', r.status === 401 && r.headers.get('x-md-lock') === '1');
  r = await fetch(`${BASE}/`, { headers: { cookie: 'md_session=' + STALE } }); let t = await r.text();
  check('stale cookie: page is 401 sign-in screen, no-store', r.status === 401 && t.includes('id="mdSignin"') && r.headers.get('cache-control') === 'no-store');
  r = await fetch(`${BASE}/?token=${STALE}`, { redirect: 'manual' }); t = await r.text();
  check('stale ?token: 401 sign-in screen with out-of-date note', r.status === 401 && t.includes('id="mdStale"') && t.includes('out of date') && !r.headers.get('set-cookie'));
  r = await fetch(`${BASE}/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ token: TOKEN }) });
  check('cross-site sign-in POST refused', r.status === 403 && !r.headers.get('set-cookie'));

  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    // Missing cookie, fresh device: lock screen; good paste (full link) sets cookie and loads the deck
    let ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); let page = await ctx.newPage();
    const r0 = await page.goto(`${BASE}/`); check('missing cookie (browser): 401 + "Sign in again"', r0.status() === 401 && await lockShown(page));
    await page.fill('#mdSignin textarea', `https://example.invalid/?token=${TOKEN}`);
    await Promise.all([page.waitForNavigation(), page.click('#mdSignin button')]);
    const ck = (await ctx.cookies()).find((c) => c.name === 'md_session');
    check('good paste sets HttpOnly+Secure+Strict cookie', !!ck && ck.httpOnly && ck.secure && ck.sameSite === 'Strict');
    check('good paste loads the deck', await deckShown(page));
    // Let the SW install/claim and cache the shell, then make the cookie stale (simulates token rotation)
    await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await deckShown(page); await page.waitForTimeout(800);
    await ctx.clearCookies(); await ctx.addCookies([{ name: 'md_session', value: STALE, url: BASE }]);
    await page.reload(); await page.waitForTimeout(1500);
    check('stale cookie + SW-cached shell: full-screen overlay from /api 401', await lockShown(page) && !!await page.$('.md-lock.over'));
    const inCache = await page.evaluate(async () => { const bad = []; for (const k of await caches.keys()) { const c = await caches.open(k); for (const q of await c.keys()) { const res = await c.match(q); const body = await res.clone().text(); if (res.status !== 200 || res.headers.get('X-MD-Lock') || body.includes('md-lock') && body.includes('mdSignin')) bad.push(k + ' ' + new URL(q.url).pathname + ' ' + res.status); } } return { bad, keys: await caches.keys() }; });
    check('SW caches hold no 401 / lock page', inCache.bad.length === 0, inCache.bad.join(', '));
    { const V = (require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'sw.js'), 'utf8').match(/VERSION = '([^']+)'/) || [])[1]; check(`SW version is current (${V})`, inCache.keys.some((k) => k.startsWith(V + '-')), inCache.keys.join(',')); }
    const swSrc = await (await fetch(`${BASE}/sw.js`)).text();
    check('SW code refuses non-200 / X-MD-Lock responses', /cacheable = \(res\) => res\.ok && res\.status === 200/.test(swSrc) && swSrc.includes('X-MD-Lock'));
    await ctx.close();

    // Screenshots (fresh context, no SW): dark + light, plus stale-link variant
    for (const scheme of ['dark', 'light']) {
      ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, serviceWorkers: 'block' }); page = await ctx.newPage();
      await page.goto(`${BASE}/`); await page.screenshot({ path: path.join(SHOTS, `lock-${scheme}.png`) });
      const theme = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
      check(`lock screen theme ${scheme}`, theme === scheme);
      await page.goto(`${BASE}/?token=${STALE}`); await page.screenshot({ path: path.join(SHOTS, `lock-stale-link-${scheme}.png`) });
      await ctx.close();
    }

    // Bad paste: rejected, then rate-limited
    ctx = await browser.newContext({ serviceWorkers: 'block' }); page = await ctx.newPage(); await page.goto(`${BASE}/`);
    await page.fill('#mdSignin textarea', STALE); await page.click('#mdSignin button'); await page.waitForTimeout(400);
    const err = await page.textContent('#mdSigninErr');
    check('bad paste rejected with message, no cookie', /didn.t work/.test(err) && !(await ctx.cookies()).some((c) => c.name === 'md_session'));
    const codes = []; for (let i = 0; i < 6; i++) codes.push((await fetch(`${BASE}/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: STALE + i }) })).status);
    const r429 = await fetch(`${BASE}/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    check('failed attempts rate-limited (429 + Retry-After, even for the right token)', codes.includes(429) && r429.status === 429 && +r429.headers.get('retry-after') > 0, codes.join(','));
    await page.fill('#mdSignin textarea', STALE); await page.click('#mdSignin button'); await page.waitForTimeout(400);
    check('rate limit shown in UI', /Too many attempts/.test(await page.textContent('#mdSigninErr')));
    await ctx.close();
  } finally { await browser.close(); }
  console.log(failed ? `${failed} FAILED` : 'all passed'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(String(e.message).split(TOKEN).join('[redacted]')); process.exit(1); });
