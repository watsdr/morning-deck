// Request-log tags test. Run: node test/isolated.js test/request-log.js --empty --port N
// Each request line in server.log ends with "dev=<mobile|android|desktop|bot> ck=<ok|no> bearer=<y|n>" and never
// carries the raw user-agent, cookie or token.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const tok = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const port = new URL(B).port;
const req = (p, headers = {}) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers }, (res) => { res.resume(); res.on('end', () => ok({ status: res.statusCode, headers: res.headers })); });
  r.on('error', no); r.end();
});
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  bot: 'curl/8.5.0',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // get a valid cookie via the sign-in link
  const s = await req(`/?token=${encodeURIComponent(tok)}`, { 'User-Agent': UA.desktop });
  const ck = (s.headers['set-cookie'] || [])[0]; assert.ok(ck, 'sign-in link sets a cookie'); const cookie = ck.split(';')[0];
  const cases = [
    ['/api/deck?t=1', { 'User-Agent': UA.iphone, Cookie: cookie }, 'dev=mobile ck=ok bearer=n'],
    ['/api/deck?t=2', { 'User-Agent': UA.android }, 'dev=android ck=no bearer=n'],
    ['/api/deck?t=3', { 'User-Agent': UA.desktop, Authorization: `Bearer ${tok}` }, 'dev=desktop ck=no bearer=y'],
    ['/api/deck?t=4', { 'User-Agent': UA.bot, Cookie: 'md_session=forged' }, 'dev=bot ck=no bearer=n'],
    ['/api/deck?t=5', { 'User-Agent': UA.iphone, Authorization: 'Bearer wrong' }, 'dev=mobile ck=no bearer=n'],
    ['/api/deck?t=6', {}, 'dev=bot ck=no bearer=n'],
  ];
  for (const [p, h] of cases) await req(p, h);
  await sleep(300);
  const log = fs.readFileSync(path.join(D, 'server.log'), 'utf8');
  const lines = log.split('\n').filter((l) => / GET \/api\/deck /.test(l));
  assert.strictEqual(lines.length, cases.length, 'one line per request');
  lines.forEach((l, i) => assert.ok(l.endsWith(' ' + cases[i][2]), `line ${i}: ${l.replace(/^\S+ /, '')}`));
  assert.ok(!log.includes(tok), 'no token in log');
  assert.ok(!log.includes(cookie.split('=')[1]), 'no cookie value in log');
  for (const ua of Object.values(UA)) assert.ok(!log.includes(ua), 'no raw user-agent in request lines');
  assert.ok(!log.includes('forged'), 'no forged cookie value in log');
  console.log('request-log: all checks passed');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
