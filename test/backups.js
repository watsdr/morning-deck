// Card-store hardening: daily backups, 14-day pruning, startup queue warning.
// Usage: node test/isolated.js test/backups.js --empty   (never run against the live data dir)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!BASE || !DATA || !DATA.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); // YYYY-MM-DD
// Run a snippet against core with a given data dir.
const core = (dir, code) => spawnSync(process.execPath, ['-e', `const core=require('./lib/core');${code}`], { cwd: ROOT, env: { ...process.env, MD_DATA_DIR: dir }, encoding: 'utf8' });
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-bk-'));
const card = (id, status = 'pending', extra = {}) => ({ id, source: 'T', title: 'Title ' + id, type: 'question', status, createdAt: new Date().toISOString(), ...extra });

(async () => {
  // 1. backup written through the real API save path, same-day overwrite
  const post = (body) => fetch(BASE + '/api/cards', { method: 'POST', headers: { Authorization: `Bearer ${env.MD_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post({ id: 'bk-1', source: 'T', title: 'first' });
  const bf = path.join(DATA, 'backups', `cards-${etToday()}.json`);
  ok(fs.existsSync(bf), `cards-${etToday()}.json written after POST /api/cards`);
  ok(rj(bf).some((c) => c.id === 'bk-1') && !rj(bf).some((c) => c.id === 'bk-2'), 'backup holds the saved cards');
  await post({ id: 'bk-2', source: 'T', title: 'second' });
  ok(rj(bf).some((c) => c.id === 'bk-1') && rj(bf).some((c) => c.id === 'bk-2'), 'latest save of the day overwrites that day\'s file');
  ok(fs.readdirSync(path.join(DATA, 'backups')).filter((f) => f.endsWith('.tmp')).length === 0, 'no leftover tmp files (atomic write)');
  ok(JSON.stringify(rj(path.join(DATA, 'cards.json'))) === JSON.stringify(rj(bf)), 'backup equals cards.json');

  // 2. pruning to newest 14 days + answers backup + empty-save safety
  const d2 = mk(); fs.mkdirSync(path.join(d2, 'backups'));
  const old = []; for (let i = 1; i <= 20; i++) { const d = new Date(Date.UTC(2026, 7, i)).toISOString().slice(0, 10); old.push(d); fs.writeFileSync(path.join(d2, 'backups', `cards-${d}.json`), '[]'); }
  fs.writeFileSync(path.join(d2, 'backups', 'cards-notes.txt'), 'keep me'); // unrelated files are never pruned
  let r = core(d2, `core.saveCards([${JSON.stringify(card('p1'))}]);core.saveAnswers([{id:'a1'}]);`);
  ok(r.status === 0, 'core.saveCards/saveAnswers ran' + (r.stderr ? ' ' + r.stderr : ''));
  const files = fs.readdirSync(path.join(d2, 'backups')).filter((f) => /^cards-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  ok(files.length === 14, `14 card backups kept (got ${files.length})`);
  ok(files.includes(`cards-${etToday()}.json`) && files.includes('cards-2026-08-20.json') && !files.includes('cards-2026-08-07.json') && files.includes('cards-2026-08-08.json'), 'newest kept, oldest removed (today + 13 newest older)');
  ok(fs.existsSync(path.join(d2, 'backups', 'cards-notes.txt')), 'unrelated files untouched');
  ok(fs.existsSync(path.join(d2, 'backups', `answers-${etToday()}.json`)), 'answers backup written too');
  core(d2, `core.saveCards([]);`);
  ok(rj(path.join(d2, 'backups', `cards-${etToday()}.json`)).length === 1, 'an empty save does not wipe the same-day backup that holds cards');
  ok(rj(path.join(d2, 'cards.json')).length === 0, '...but cards.json itself is saved as asked');

  // 3. startup warning (real server process per scenario)
  const port = +new URL(BASE).port + 1;
  const start = async (dir) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, MD_DATA_DIR: dir, MD_PORT: String(port), MD_DIAG_LOG: path.join(dir, 'diag.log') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    for (let i = 0; i < 50 && !/listening/.test(out); i++) await sleep(100);
    return { p, out: () => out };
  };
  const stop = (s) => new Promise((res) => { s.p.on('exit', res); s.p.kill('SIGTERM'); });
  const lost = [card('lost-1', 'pending', { title: 'Lost one', body: 'SECRET BODY' }), card('lost-2'), card('done-1', 'answered')];
  const day = '2026-10-16';
  const d3 = mk(); fs.mkdirSync(path.join(d3, 'backups'));
  fs.writeFileSync(path.join(d3, 'backups', `cards-${day}.json`), JSON.stringify(lost));
  fs.writeFileSync(path.join(d3, 'backups', 'cards-2026-10-01.json'), JSON.stringify([card('older')]));
  fs.writeFileSync(path.join(d3, 'cards.json'), '[]\n');
  let s = await start(d3);
  const wf = path.join(d3, 'queue-warning.json');
  ok(fs.existsSync(wf), 'queue-warning.json written when cards.json is empty and newest backup has pending cards');
  const w = fs.existsSync(wf) ? rj(wf) : {};
  ok(w.pendingInBackup === 2 && /cards-2026-10-16\.json$/.test(w.backupFile || '') && !!w.at, 'warning has timestamp, newest backup file, count of pending');
  ok(JSON.stringify((w.cards || []).map((c) => [c.id, c.title])) === JSON.stringify([['lost-1', 'Lost one'], ['lost-2', 'Title lost-2']]), 'warning lists ids and titles only');
  ok(!JSON.stringify(w).includes('SECRET BODY') && (w.cards || []).every((c) => Object.keys(c).sort().join() === 'id,title'), 'no card bodies or other data in the warning');
  ok(/WARNING: cards\.json has no pending cards/.test(s.out()), 'clear warning logged to stdout/log');
  ok(fs.readFileSync(path.join(d3, 'cards.json'), 'utf8').trim() === '[]', 'cards.json NOT auto-restored');
  await stop(s);

  // warning cleared once cards.json has pending cards again
  fs.writeFileSync(path.join(d3, 'cards.json'), JSON.stringify([card('refiled')]));
  s = await start(d3);
  ok(!fs.existsSync(wf), 'queue-warning.json removed at start when cards.json has pending cards again');
  await stop(s);

  // no warning when there is no backup, or the newest backup has nothing pending
  const d4 = mk(); fs.writeFileSync(path.join(d4, 'cards.json'), '[]\n');
  s = await start(d4); ok(!fs.existsSync(path.join(d4, 'queue-warning.json')), 'no warning without any backup'); await stop(s);
  fs.mkdirSync(path.join(d4, 'backups')); fs.writeFileSync(path.join(d4, 'backups', `cards-${day}.json`), JSON.stringify([card('x', 'answered')]));
  fs.writeFileSync(path.join(d4, 'queue-warning.json'), '{"stale":true}');
  s = await start(d4); ok(!fs.existsSync(path.join(d4, 'queue-warning.json')), 'stale warning removed when the newest backup has no pending cards'); await stop(s);

  console.log(fails ? `${fails} FAILED` : 'all backup tests passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
