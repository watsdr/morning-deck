// Off-box backup mirror (persistent agent store) + queue warning across both locations.
// Usage: node test/isolated.js test/backup-mirror.js --empty   (uses temp dirs only; never the live data or the real store)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DATA = process.env.MD_DATA_DIR;
if (!DATA || !DATA.startsWith(os.tmpdir())) { console.error('run via test/isolated.js'); process.exit(2); }
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const core = (dir, mirror, code) => spawnSync(process.execPath, ['-e', `const core=require('./lib/core');${code}`], { cwd: ROOT, env: { ...process.env, MD_DATA_DIR: dir, ...(mirror === undefined ? {} : { MD_BACKUP_MIRROR_DIR: mirror }) }, encoding: 'utf8' });
const card = (id, status = 'pending') => ({ id, source: 'T', title: 'Title ' + id, type: 'question', status, createdAt: new Date().toISOString() });

(async () => {
  // defaults: off for test data dirs, the agent store for the live ./data
  const env0 = { ...process.env }; delete env0.MD_BACKUP_MIRROR_DIR; delete env0.MD_DATA_DIR; delete env0.DATA_DIR;
  let r = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("./lib/core").MIRROR_DIR)'], { cwd: ROOT, env: env0, encoding: 'utf8' });
  ok(r.stdout.startsWith('/cursor/stores/') && !r.stdout.startsWith('/workspace'), `live mirror dir is outside /workspace (${r.stdout})`);
  r = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("./lib/core").MIRROR_DIR)'], { cwd: ROOT, env: { ...env0, MD_DATA_DIR: DATA }, encoding: 'utf8' });
  ok(r.stdout === '', 'mirror is off for a non-live data dir unless MD_BACKUP_MIRROR_DIR is set');

  // mirror written on each save, 30-day pruning, empty-save safety
  const d = mk('md-test-mr-'); const m = path.join(mk('md-test-mirror-'), 'morning-deck-backups');
  for (let i = 1; i <= 35; i++) { const day = new Date(Date.UTC(2026, 7, i)).toISOString().slice(0, 10); fs.mkdirSync(m, { recursive: true }); fs.writeFileSync(path.join(m, `cards-${day}.json`), '[]'); }
  r = core(d, m, `core.saveCards([${JSON.stringify(card('c1'))}]);core.saveAnswers([{id:'a1'}]);`);
  ok(r.status === 0, 'save ran ' + (r.stderr || ''));
  const mf = path.join(m, `cards-${etToday()}.json`);
  ok(fs.existsSync(mf) && rj(mf)[0].id === 'c1', 'mirror holds today\'s cards');
  ok(fs.existsSync(path.join(m, `answers-${etToday()}.json`)), 'answers mirrored too');
  ok((fs.statSync(mf).mode & 0o777) === 0o600, 'mirror file mode 600 (on a normal filesystem)');
  const kept = fs.readdirSync(m).filter((f) => /^cards-/.test(f));
  ok(kept.length === 30, `mirror keeps 30 days (got ${kept.length})`);
  ok(fs.existsSync(path.join(d, 'backups', `cards-${etToday()}.json`)), 'local backup still written');
  ok(!fs.readdirSync(m).some((f) => f.endsWith('.tmp')), 'no tmp files left in mirror');
  core(d, m, 'core.saveCards([]);');
  ok(rj(mf).length === 1, 'empty save does not wipe the same-day mirror backup');
  // a broken mirror never fails the save
  const bad = path.join(d, 'cards.json', 'nope');
  r = core(mk('md-test-mr2-'), bad, `core.saveCards([${JSON.stringify(card('c2'))}]);console.log('saved')`);
  ok(r.status === 0 && /saved/.test(r.stdout), 'mirror failure does not fail the save');

  // queue warning uses the newest backup in EITHER location
  const port = +new URL(process.env.MD_BASE).port + 2;
  const start = async (dir, mirror) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, MD_DATA_DIR: dir, MD_BACKUP_MIRROR_DIR: mirror, MD_PORT: String(port), MD_DIAG_LOG: path.join(dir, 'diag.log') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (x) => (out += x)); p.stderr.on('data', (x) => (out += x));
    for (let i = 0; i < 50 && !/listening/.test(out); i++) await sleep(100);
    await new Promise((res) => { p.on('exit', res); p.kill('SIGTERM'); });
    return out;
  };
  const d3 = mk('md-test-mr3-'); const m3 = mk('md-test-mirror3-');
  fs.writeFileSync(path.join(d3, 'cards.json'), '[]'); fs.mkdirSync(path.join(d3, 'backups'));
  fs.writeFileSync(path.join(d3, 'backups', 'cards-2026-10-10.json'), '[]'); // older local backup, nothing pending
  fs.writeFileSync(path.join(m3, 'cards-2026-10-16.json'), JSON.stringify([card('lost-1'), card('lost-2')])); // newer, mirror only
  let out = await start(d3, m3);
  const qw = path.join(d3, 'queue-warning.json');
  ok(fs.existsSync(qw) && rj(qw).pendingInBackup === 2 && rj(qw).backupLocation === 'mirror', 'warning raised from the newer mirror backup');
  ok(/WARNING: cards.json has no pending cards but cards-2026-10-16.json has 2/.test(out), 'warning logged');
  ok(rj(path.join(d3, 'cards.json')).length === 0, 'nothing restored automatically');
  fs.writeFileSync(path.join(d3, 'backups', 'cards-2026-10-17.json'), '[]'); // newer local backup with nothing pending wins
  await start(d3, m3);
  ok(!fs.existsSync(qw), 'newer local backup (empty) clears the warning');
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
