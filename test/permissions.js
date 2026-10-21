// Data permissions: dirs 700, data files 600, also after atomic rewrites, backups and uploads.
// Usage: node test/isolated.js test/permissions.js --empty   (temp data dir + throwaway port; never live data)
const fs = require('fs'); const path = require('path'); const os = require('os'); const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!BASE || !DATA || DATA === path.join(ROOT, 'data')) { console.error('run via: node test/isolated.js test/permissions.js --empty'); process.exit(2); }
let failed = 0; const out = [];
const check = (n, ok, info = '') => { out.push(`${ok ? 'PASS' : 'FAIL'} ${n}${info ? ' — ' + info : ''}`); if (!ok) failed++; };
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const api = (p, o = {}) => fetch(BASE + p, { ...o, headers: { Authorization: `Bearer ${env.MD_TOKEN}`, 'Content-Type': 'application/json', ...(o.headers || {}) } });
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const id = 'perm-test-' + Date.now();
  check('POST /api/cards', (await api('/api/cards', { method: 'POST', body: JSON.stringify({ id, source: 'test', title: 'perm test' }) })).status === 201);
  const up = await (await api('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })).json();
  check('POST /api/uploads', !!up.id, up.error || '');
  check('POST /api/answers', (await api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: id, gesture: 'tap3', text: 'hi', attachments: [up.id] }) })).status === 201);
  check('undo (second atomic rewrite)', (await api('/api/answers/undo', { method: 'POST', body: JSON.stringify({ cardId: id }) })).status === 201);
  for (const d of ['', 'backups', 'uploads']) check(`dir ${d || 'data'} is 700`, mode(path.join(DATA, d)) === '700', mode(path.join(DATA, d)));
  for (const f of ['cards.json', 'answers.json']) check(`${f} is 600 after rewrites`, mode(path.join(DATA, f)) === '600', mode(path.join(DATA, f)));
  const backups = fs.readdirSync(path.join(DATA, 'backups')).filter((f) => f.endsWith('.json'));
  check('backups written', backups.length >= 2, backups.join(','));
  for (const f of backups) check(`backups/${f} is 600`, mode(path.join(DATA, 'backups', f)) === '600', mode(path.join(DATA, 'backups', f)));
  for (const f of fs.readdirSync(path.join(DATA, 'uploads'))) check(`uploads/${f} is 600`, mode(path.join(DATA, 'uploads', f)) === '600', mode(path.join(DATA, 'uploads', f)));
  check('no leftover .tmp files', !fs.readdirSync(DATA).concat(fs.readdirSync(path.join(DATA, 'backups'))).some((f) => f.endsWith('.tmp')));
  // Startup hardening on a loose, pre-existing store (scratch dir only): chmod fixes modes, contents untouched.
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'md-perm-loose-'));
  fs.chmodSync(loose, 0o755); fs.mkdirSync(path.join(loose, 'backups'), { mode: 0o755 }); fs.mkdirSync(path.join(loose, 'uploads'), { mode: 0o755 });
  const body = '[]\n';
  for (const f of ['cards.json', 'answers.json', 'backups/cards-2026-01-01.json']) { fs.writeFileSync(path.join(loose, f), body); fs.chmodSync(path.join(loose, f), 0o644); }
  const r = spawnSync(process.execPath, ['-e', `const c=require('./lib/core');if(c.DATA_DIR!==${JSON.stringify(loose)})throw 1;console.log(c.hardenPermissions().length)`], { cwd: ROOT, env: { ...process.env, MD_DATA_DIR: loose }, encoding: 'utf8' });
  check('hardenPermissions ran', r.status === 0, (r.stdout + r.stderr).trim());
  check('existing dirs tightened to 700', ['', 'backups', 'uploads'].every((d) => mode(path.join(loose, d)) === '700'));
  check('existing data files tightened to 600, contents unchanged', ['cards.json', 'answers.json', 'backups/cards-2026-01-01.json'].every((f) => mode(path.join(loose, f)) === '600' && fs.readFileSync(path.join(loose, f), 'utf8') === body));
  fs.rmSync(loose, { recursive: true, force: true });
  console.log(out.join('\n')); console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
