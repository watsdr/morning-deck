// QR pairing test. Run: node test/isolated.js test/qr-pairing.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs'); const jsQR = require('jsqr');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const tok = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const port = new URL(B).port;
// raw request so we control Host / forwarding headers
const req = (method, p, headers = {}, body) => new Promise((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
  r.on('error', no); if (body) r.write(body); r.end();
});
const bearer = { Authorization: `Bearer ${tok}` };
const decode = (buf) => { const png = PNG.sync.read(buf); return jsQR(new Uint8ClampedArray(png.data), png.width, png.height).data; };
const pair = (code, h = {}) => req('POST', '/pair', { 'Content-Type': 'application/json', ...h }, JSON.stringify({ code }));
(async () => {
  // box-only page
  let r = await req('GET', '/signin/qr', bearer);
  assert.strictEqual(r.status, 200); assert.match(r.body.toString(), /<svg/); assert.strictEqual(r.headers['cache-control'], 'no-store');
  r = await req('GET', '/signin/qr', { ...bearer, 'X-Forwarded-For': '1.2.3.4' }); assert.strictEqual(r.status, 404, 'funnel-forwarded request refused');
  r = await req('GET', '/signin/qr', { ...bearer, Host: 'morning-deck.tail164b96.ts.net' }); assert.strictEqual(r.status, 404, 'public Host refused');
  r = await req('GET', '/signin/qr'); assert.strictEqual(r.status, 401, 'still needs auth locally');
  r = await req('POST', '/api/pair/qr.png', { 'X-Forwarded-For': '1.2.3.4', ...bearer }); assert.strictEqual(r.status, 404);
  // script writes the PNG, prints no code / token
  const out = path.join(D, 'pair-qr.png');
  const s = spawnSync('bash', ['scripts/pair-qr.sh'], { cwd: ROOT, env: { ...process.env, MD_PORT_OVERRIDE: port, MD_PAIR_OUT: out }, encoding: 'utf8' });
  assert.strictEqual(s.status, 0, s.stderr);
  assert.strictEqual((fs.statSync(out).mode & 0o777).toString(8), '600');
  const url = new URL(decode(fs.readFileSync(out)));
  assert.strictEqual(url.origin, 'https://morning-deck.tail164b96.ts.net'); assert.strictEqual(url.pathname, '/pair');
  const code = url.hash.slice(1); assert.strictEqual(code.length, 43);
  assert.ok(!(s.stdout + s.stderr).includes(code) && !(s.stdout + s.stderr).includes(tok), 'script prints neither code nor token');
  // GET /pair page is public, carries nothing
  r = await req('GET', '/pair'); assert.strictEqual(r.status, 200); assert.ok(!r.body.toString().includes(code));
  r = await pair(code, { 'Sec-Fetch-Site': 'cross-site' }); assert.strictEqual(r.status, 403);
  r = await pair(code, { 'X-Forwarded-For': '9.9.9.1' });
  assert.strictEqual(r.status, 200);
  const ck = r.headers['set-cookie'][0];
  assert.match(ck, /^md_session=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=15552000$/);
  r = await pair(code, { 'X-Forwarded-For': '9.9.9.1' }); assert.strictEqual(r.status, 401, 'code burned');
  r = await req('GET', '/api/deck', { Cookie: ck.split(';')[0] }); assert.strictEqual(r.status, 200, 'paired cookie works');
  // expiry: a fresh code from the page works, a fake one fails; rate limit per client
  for (let i = 0; i < 9; i++) assert.strictEqual((await pair('A'.repeat(43), { 'X-Forwarded-For': '9.9.9.2' })).status, 401);
  r = await pair('A'.repeat(43), { 'X-Forwarded-For': '9.9.9.2' }); assert.strictEqual(r.status, 401);
  r = await pair('A'.repeat(43), { 'X-Forwarded-For': '9.9.9.2' }); assert.strictEqual(r.status, 429, 'rate limited');
  // nothing secret in the server log
  const log = fs.readFileSync(path.join(D, 'server.log'), 'utf8');
  assert.ok(!log.includes(code) && !log.includes(tok), 'log has neither code nor token');
  // unit: TTL
  const pairing = require('../lib/pairing'); const c = pairing.create(1000);
  assert.strictEqual(pairing.redeem(c.code, 1000 + pairing.TTL_MS + 1), false, 'expired after 5 min');
  console.log('qr-pairing: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
