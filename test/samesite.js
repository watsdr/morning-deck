// Session cookie flags + cross-site navigation check (SameSite=Strict). Real Chrome via playwright-core.
// Usage: node test/isolated.js test/samesite.js   (temp data dir + throwaway port; never the live server)
// A second tiny server on http://localhost:<port+100> plays "another app/site" (localhost and 127.0.0.1 are different
// sites), with links into the deck. Checks: ?token sets an HttpOnly+Secure+Strict cookie over plain http://127.0.0.1,
// a direct load with the cookie works, and links from the other site (cookie-only, and ?token) still open the deck,
// both without a service worker (fresh device) and with the SW-cached shell (installed app).
const fs = require('fs'); const path = require('path'); const http = require('http');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE || '';
const port = +new URL(BASE || 'http://x:0').port;
if (!BASE || port === +(env.MD_PORT || 8787)) { console.error('run via: node test/isolated.js test/samesite.js'); process.exit(2); }
const FOREIGN = `http://localhost:${port + 100}`;
const results = []; let failed = 0;
const check = (name, ok, info = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); if (!ok) failed++; };
const foreign = http.createServer((req, res) => {
  const to = new URL(req.url, FOREIGN).searchParams.get('to') || '/';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><a id="go" href="${to.replace(/"/g, '&quot;')}">open deck</a>`);
});
async function viaLink(page, target) { // click a link on the other site; return the status of every document response
  const docs = [];
  const onResp = (r) => { if (r.request().resourceType() === 'document' && r.url().startsWith(BASE)) docs.push(r.status()); };
  page.on('response', onResp);
  await page.goto(`${FOREIGN}/?to=${encodeURIComponent(target)}`);
  await Promise.all([page.waitForURL((u) => u.href.startsWith(BASE), { timeout: 10000 }), page.click('#go')]);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);
  page.off('response', onResp);
  return docs;
}
const deckShown = (page) => page.$('.card[data-id]').then((x) => !!x);
const lockedShown = (page) => page.evaluate(() => /Morning Deck is private|Locked/.test(document.body.innerText));
(async () => {
  await new Promise((r) => foreign.listen(port + 100, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    // 1. Fresh device, no SW: ?token typed/opened directly
    let ctx = await browser.newContext({ serviceWorkers: 'block' });
    let page = await ctx.newPage();
    const r0 = await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
    const ck = (await ctx.cookies()).find((c) => c.name === 'md_session');
    check('cookie set over http://127.0.0.1', !!ck);
    check('cookie flags HttpOnly+Secure+Strict', !!ck && ck.httpOnly && ck.secure && ck.sameSite === 'Strict', ck ? `httpOnly=${ck.httpOnly} secure=${ck.secure} sameSite=${ck.sameSite} expiresInDays=${Math.round((ck.expires * 1000 - Date.now()) / 864e5)}` : 'no cookie');
    check('token stripped from URL', !page.url().includes('token='), page.url().replace(BASE, ''));
    check('deck renders after ?token', r0.status() === 200 && await deckShown(page));
    // 2. Direct reload / browser-initiated load with the cookie only
    const r1 = await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    check('direct page load with cookie: 200 + deck', r1.status() === 200 && await deckShown(page));
    // 3. Cross-site link, cookie only, no SW
    let docs = await viaLink(page, `${BASE}/`);
    check('cross-site link (cookie, no SW) opens the deck', await deckShown(page), `document statuses ${JSON.stringify(docs)}`);
    results.push(`INFO raw first cross-site navigation status: ${docs[0]} (401 => Strict cookie withheld on the cross-site request itself)`);
    // API from the page is same-origin, so the Strict cookie is sent
    const apiStatus = await page.evaluate(() => fetch('/api/deck', { credentials: 'same-origin' }).then((r) => r.status));
    check('same-origin /api/deck from the page sends the cookie', apiStatus === 200, String(apiStatus));
    await ctx.close();
    // 4. Fresh device, no SW: cross-site ?token link (chat/email/TWA-style first launch)
    ctx = await browser.newContext({ serviceWorkers: 'block' }); page = await ctx.newPage();
    docs = await viaLink(page, `${BASE}/?token=${env.MD_TOKEN}&source=twa`);
    check('cross-site ?token link (no SW) opens the deck', await deckShown(page), `document statuses ${JSON.stringify(docs)}; url ${page.url().replace(BASE, '')}`);
    await ctx.close();
    // 5. Installed-app style: SW registered and shell cached, then cross-site link
    ctx = await browser.newContext(); page = await ctx.newPage();
    await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload({ waitUntil: 'networkidle' });
    docs = await viaLink(page, `${BASE}/?source=twa`);
    check('cross-site link with SW-cached shell opens the deck', await deckShown(page), `document statuses ${JSON.stringify(docs)}`);
    // 6. No cookie at all from a cross-site link: still locked (no loop)
    const ctx2 = await browser.newContext({ serviceWorkers: 'block' }); const p2 = await ctx2.newPage();
    let n = 0; p2.on('request', (r) => { if (r.resourceType() === 'document' && r.url().startsWith(BASE)) n++; });
    await viaLink(p2, `${BASE}/`);
    check('cross-site link without a cookie stays locked (no redirect loop)', await lockedShown(p2) && n <= 2, `${n} document requests`);
    // 7. ?token on /api is refused; Bearer works
    const qa = await fetch(`${BASE}/api/deck?token=${env.MD_TOKEN}`); const ba = await fetch(`${BASE}/api/deck`, { headers: { Authorization: `Bearer ${env.MD_TOKEN}` } });
    check('/api/deck?token= is 401, Bearer is 200', qa.status === 401 && ba.status === 200, `${qa.status}/${ba.status}`);
    await ctx.close(); await ctx2.close();
  } finally { await browser.close(); foreign.close(); }
  console.log(results.join('\n'));
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
