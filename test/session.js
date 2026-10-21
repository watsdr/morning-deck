// Stale or missing session: sign-in screen, paste-to-cookie, rate limit, service worker must not cache 401s.
// Usage: node test/isolated.js test/session.js --empty
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE;
const TOKEN = env.MD_TOKEN;
if (!BASE || !TOKEN || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }

const STALE = 'md-stale-link-DO-NOT-ECHO-9f3a';
const BAD = 'md-bad-paste-DO-NOT-ECHO-9f3a';
const SECRETS = [TOKEN, STALE, BAD];
const ART = '/opt/cursor/artifacts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const redact = (s) => SECRETS.reduce((t, secret) => t.split(secret).join('[secret]'), String(s ?? '')).slice(0, 280);
const ok = (n, c, i) => { if (!c) bad++; console.log(c ? 'PASS' : 'FAIL', n, i !== undefined ? redact(typeof i === 'string' ? i : JSON.stringify(i)) : ''); };

const cookieValue = crypto.createHash('sha256').update('morning-deck-cookie:' + TOKEN).digest('base64url');
const cookiePair = (setCookie) => String(setCookie || '').split(';')[0];
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA, timezoneId: 'America/New_York' };

function leaked(text) { return SECRETS.some((s) => s && String(text).includes(s)); }

async function postSession(body, headers = {}) {
  const r = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: r.status, text, json, setCookie: r.headers.get('set-cookie') || '', retry: r.headers.get('retry-after') };
}

(async () => {
  // ---------- HTTP: missing cookie, stale cookie, stale query token ----------
  {
    const r = await fetch(BASE + '/', { headers: { Accept: 'text/html' } });
    const text = await r.text();
    ok('missingCookieIsSignInScreen', r.status === 200 && r.headers.get('x-md-lock') === '1' && /no-store/i.test(r.headers.get('cache-control') || '') && text.includes('Sign in again') && text.includes('lockToken') && !text.includes('out of date link'), r.status);
    ok('missingCookieDoesNotEcho', !leaked(text));
  }
  {
    const r = await fetch(BASE + '/', { headers: { Accept: 'text/html', Cookie: 'md_session=stale-cookie-value' } });
    const text = await r.text();
    ok('staleCookieIsSignInScreen', r.status === 200 && text.includes('Sign in again') && text.includes('id="lockToken"') && !text.includes('out of date link'), r.status);
    ok('staleCookieDoesNotEcho', !leaked(text));
  }
  {
    const r = await fetch(BASE + '/?token=' + encodeURIComponent(STALE) + '&source=pwa', { redirect: 'manual', headers: { Accept: 'text/html' } });
    const loc = r.headers.get('location') || '';
    const text = await r.text();
    ok('staleQueryRedirectsNot401', r.status === 302 && !leaked(loc) && !leaked(text) && loc.includes('link=expired') && loc.includes('source=pwa') && !loc.includes('token='), { status: r.status, loc });
    const page = await fetch(BASE + loc, { headers: { Accept: 'text/html' } });
    const html = await page.text();
    ok('staleQueryLandsOnSignInWithNote', page.status === 200 && page.headers.get('x-md-lock') === '1' && html.includes('Sign in again') && html.includes('out of date link') && html.includes('lockToken'), page.status);
    ok('staleQueryPageDoesNotEcho', !leaked(html));
  }
  {
    const api = await fetch(BASE + '/api/deck');
    const body = await api.text();
    ok('apiStill401WithoutCookie', api.status === 401 && body.includes('unauthorized') && !body.includes('Sign in again') && !leaked(body), api.status);
    const css = await fetch(BASE + '/styles.css');
    const cssBody = await css.text();
    ok('cssWithoutCookieIsNotLockPage', css.status === 401 && !cssBody.includes('Sign in again') && !cssBody.includes('<html'), css.status);
  }
  {
    // A fresh cookie still wins over a dead wrapper link: strip the token, stay signed in.
    const good = await fetch(BASE + '/?token=' + encodeURIComponent(TOKEN), { redirect: 'manual' });
    const set = good.headers.get('set-cookie') || '';
    const loc = good.headers.get('location') || '';
    ok('validQuerySetsCookieAndStripsToken', good.status === 302 && loc === '/' && !leaked(loc) && /HttpOnly/i.test(set) && /SameSite=Lax/i.test(set) && cookiePair(set) === 'md_session=' + cookieValue, { status: good.status, loc });
    const again = await fetch(BASE + '/?token=' + encodeURIComponent(STALE), { redirect: 'manual', headers: { Cookie: cookiePair(set), Accept: 'text/html' } });
    const loc2 = again.headers.get('location') || '';
    const body2 = await again.text();
    ok('staleQueryWithLiveCookieStaysSignedIn', again.status === 302 && loc2 === '/' && !leaked(loc2) && !leaked(body2) && !body2.includes('out of date link'), { status: again.status, loc: loc2 });
  }

  // ---------- paste endpoint: reject, rate-limit, accept ----------
  {
    let saw401 = false, saw429 = false, echo = false;
    const samples = ['x', BAD, 'short-token', BAD.repeat(40).slice(0, 1800)];
    for (let i = 0; i < 12 && !saw429; i++) {
      const guess = samples[i % samples.length] + (i > 3 ? '-' + i : '');
      const r = await postSession({ token: i === 1 ? `${BASE}/?token=${encodeURIComponent(guess)}` : guess });
      if (leaked(r.text)) echo = true;
      if (r.status === 401) saw401 = true;
      if (r.status === 429) { saw429 = true; ok('rateLimitRetryAfter', Number(r.retry) > 0, r.retry); }
      ok('failedPasteHasNoCookie', !(r.setCookie || '').includes('md_session='));
    }
    ok('badPasteRejectedThenRateLimited', saw401 && saw429 && !echo);
  }
  {
    const link = `${BASE}/?foo=1&token=${encodeURIComponent(TOKEN)}`;
    const r = await postSession({ token: link }, { 'X-Forwarded-Proto': 'https' });
    const set = r.setCookie;
    ok('validPasteSetsCookie', r.status === 200 && r.json && r.json.ok === true && !leaked(r.text) && /HttpOnly/i.test(set) && /Secure/i.test(set) && /SameSite=Lax/i.test(set) && cookiePair(set) === 'md_session=' + cookieValue, r.status);
    const deck = await fetch(BASE + '/api/deck', { headers: { Cookie: cookiePair(set) } });
    ok('pastedCookieLoadsDeck', deck.status === 200 && (await deck.json()).count >= 1, deck.status);
  }
  {
    const badForm = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: BAD }) });
    const badHtml = await badForm.text();
    ok('badFormPasteRejectedInPage', badForm.status === 200 && badForm.headers.get('x-md-lock') === '1' && badHtml.includes('did not work') && badHtml.includes('Sign in again') && !leaked(badHtml), badForm.status);
    const goodForm = await fetch(BASE + '/api/session', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: `${BASE}/?token=${encodeURIComponent(TOKEN)}` }) });
    const set = goodForm.headers.get('set-cookie') || '';
    const loc = goodForm.headers.get('location') || '';
    ok('validFormPasteRedirectsWithCookie', goodForm.status === 303 && loc === '/' && !leaked(loc) && /HttpOnly/i.test(set) && /SameSite=Lax/i.test(set), { status: goodForm.status, loc });
  }

  const log = fs.readFileSync(path.join(process.env.MD_DATA_DIR, 'server.log'), 'utf8');
  ok('serverLogRedactsTokens', !leaked(log) && log.includes('?token=[redacted]'));

  // ---------- phone UI ----------
  fs.mkdirSync(ART, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const shot = async (page, name) => {
    const file = path.join(ART, name);
    await page.screenshot({ path: file });
    console.log('shot', file);
    return file;
  };
  async function openLock(colorScheme, url) {
    const ctx = await browser.newContext({ ...phone, colorScheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#lockTitle');
    await page.waitForFunction(() => { const img = document.querySelector('.lock-logo'); return img && img.complete && img.naturalWidth > 0; });
    return { ctx, page, res, errors };
  }
  try {
    {
      const { ctx, page, res, errors } = await openLock('dark', '/?token=' + encodeURIComponent(STALE));
      const html = await page.content();
      const color = await page.evaluate(() => getComputedStyle(document.querySelector('#lockTitle')).color);
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.lock-screen')).backgroundImage);
      const box = await page.locator('#lockScreen').boundingBox();
      ok('phoneStaleLinkDark', res.status() === 200 && !page.url().includes(STALE) && !page.url().includes('token=') && html.includes('out of date link') && !leaked(html) && color === 'rgb(255, 255, 255)' && bg && bg !== 'none' && box && box.height > 700 && (await page.locator('.card.skeleton').count()) === 0 && !errors.length, { status: res.status(), url: page.url().replace(STALE, '[stale]'), color, errors });
      await shot(page, 'lock_screen_dark_stale_link.png');
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await openLock('light', '/?token=' + encodeURIComponent(STALE));
      const color = await page.evaluate(() => getComputedStyle(document.querySelector('#lockTitle')).color);
      const field = await page.evaluate(() => getComputedStyle(document.querySelector('#lockToken')).backgroundColor);
      ok('phoneStaleLinkLight', color === 'rgb(29, 24, 50)' && field === 'rgb(255, 255, 255)' && !page.url().includes(STALE) && !errors.length, { color, field, errors });
      await shot(page, 'lock_screen_light_stale_link.png');
      await ctx.close();
    }
    {
      const { ctx, page, res, errors } = await openLock('dark', '/');
      const html = await page.content();
      ok('phoneMissingCookie', res.status() === 200 && html.includes('Sign in again') && !html.includes('out of date link') && (await page.locator('.card.skeleton').count()) === 0 && !errors.length, res.status());
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ ...phone, colorScheme: 'dark' });
      await ctx.addCookies([{ name: 'md_session', value: 'not-a-real-session', url: BASE, httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      const res = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#lockTitle');
      ok('phoneStaleCookie', res.status() === 200 && (await page.locator('#lockTitle').textContent()) === 'Sign in again' && (await page.locator('#lockStale').count()) === 0);
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ ...phone, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let answers = 0;
      page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/answers')) answers++; });
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#lockForm');
      let rejected = false, limited = false, echo = false;
      for (let i = 0; i < 8 && !limited; i++) {
        await page.fill('#lockToken', i === 3 ? `${BASE}/?token=${encodeURIComponent(BAD)}` : BAD);
        await page.click('#lockSubmit');
        await page.waitForFunction(() => {
          const btn = document.getElementById('lockSubmit');
          const n = document.getElementById('lockError');
          return btn && !btn.disabled && n && !n.hidden && n.textContent.trim();
        });
        const msg = await page.textContent('#lockError');
        if (leaked(msg)) echo = true;
        if (/did not work/i.test(msg)) rejected = true;
        if (/too many attempts/i.test(msg)) limited = true;
      }
      ok('phoneBadPasteRejectedAndRateLimited', rejected && limited && !echo && page.url().startsWith(BASE) && !page.url().includes(BAD) && answers === 0 && !errors.length, { rejected, limited, echo, answers, errors });
      await page.fill('#lockToken', `${BASE}/?token=${encodeURIComponent(TOKEN)}`);
      await page.click('#lockSubmit');
      await page.waitForSelector('.card[data-id]', { timeout: 10000 });
      const cookies = await ctx.cookies();
      const c = cookies.find((x) => x.name === 'md_session');
      const finalHtml = await page.content();
      ok('phoneValidPasteSetsCookieAndLoadsDeck', !!c && c.httpOnly && String(c.sameSite).toLowerCase() === 'lax' && c.value === cookieValue && !page.url().includes('token=') && !leaked(finalHtml) && (await page.locator('.card[data-id]').count()) > 0 && answers === 0, { httpOnly: c && c.httpOnly, sameSite: c && c.sameSite, cards: await page.locator('.card[data-id]').count() });
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ ...phone, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(BASE + '/?link=expired', { waitUntil: 'domcontentloaded' });
      await Promise.race([
        page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; }),
        sleep(15000).then(() => { throw new Error('service worker ready timed out'); }),
      ]);
      const audit = () => page.evaluate(async () => {
        const out = [];
        for (const k of await caches.keys()) {
          const c = await caches.open(k);
          for (const req of await c.keys()) {
            const res = await c.match(req);
            out.push({ cache: k, url: new URL(req.url).pathname, status: res.status, lock: res.headers.get('X-MD-Lock'), cc: res.headers.get('Cache-Control') || '' });
          }
        }
        return out;
      });
      const before = await audit();
      ok('swInstallSkipsLockPageAnd401s', before.every((e) => e.status !== 401 && e.lock !== '1' && !/no-store/i.test(e.cc)) && !before.some((e) => e.url === '/' || e.url === '/styles.css' || e.url === '/app.js'), before);
      await page.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.card[data-id]');
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.card[data-id]');
      const signedIn = await audit();
      const home = signedIn.find((e) => e.url === '/' && e.cache.endsWith('-shell'));
      ok('swCachesRealShellNotLockPage', !!home && home.status === 200 && home.lock !== '1' && signedIn.every((e) => e.status !== 401 && e.lock !== '1'), signedIn.filter((e) => e.status !== 200 || e.lock));
      await ctx.clearCookies();
      await ctx.addCookies([{ name: 'md_session', value: 'stale-after-install', url: BASE, httpOnly: true, sameSite: 'Lax' }]);
      let unauth = 0;
      page.on('response', (r) => { if (r.status() === 401 && new URL(r.url()).pathname.startsWith('/api/')) unauth++; });
      await page.evaluate(() => fetch('/api/deck', { credentials: 'same-origin' }));
      const after401 = await audit();
      ok('swDoesNotCacheApi401', after401.every((e) => e.status !== 401 && e.lock !== '1') && unauth >= 1, { unauth, bad: after401.filter((e) => e.status === 401 || e.lock === '1') });
      const atReload = unauth;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#lockScreen:not([hidden])', { timeout: 8000 });
      await page.waitForFunction(() => document.querySelectorAll('.card.skeleton').length === 0);
      await sleep(2000);
      const title = await page.locator('#lockTitle').textContent();
      const box = await page.locator('#lockScreen').boundingBox();
      const stillShell = await audit();
      ok('phoneApp401ShowsSignInNotSpinner', title === 'Sign in again' && box && box.height > 700 && (await page.locator('.card.skeleton').count()) === 0 && unauth - atReload <= 3 && unauth <= 8 && stillShell.every((e) => e.status !== 401 && e.lock !== '1') && stillShell.some((e) => e.url === '/' && e.status === 200) && !errors.length, { unauth, delta: unauth - atReload, errors });
      await shot(page, 'lock_screen_dark_stale_cookie.png');
      // Old wrapper link while the installed shell is already cached: same screen, with the out-of-date note, token gone.
      await page.goto(BASE + '/?token=' + encodeURIComponent(STALE), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#lockStale:not([hidden])', { timeout: 8000 });
      const note = await page.locator('#lockStale').textContent();
      const shellHtml = await page.content();
      ok('cachedShellStaleLinkShowsNote', !page.url().includes(STALE) && !page.url().includes('token=') && /out of date link/.test(note) && !leaked(shellHtml), page.url());
      await page.fill('#lockToken', TOKEN);
      await page.click('#lockSubmit');
      await page.waitForSelector('.card[data-id]', { timeout: 10000 });
      const c = (await ctx.cookies()).find((x) => x.name === 'md_session');
      ok('phoneInAppPasteReloadsDeck', !!c && c.value === cookieValue && (await page.locator('#lockScreen').getAttribute('hidden')) !== null && (await page.locator('.card[data-id]').count()) > 0);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  if (bad) console.log(bad + ' FAILED');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(redact(e && e.stack || e)); process.exit(1); });
