// Backup staging + secret scan + restore integrity. Run: node test/isolated.js test/backup-drive.js
const assert = require('assert'); const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const D = process.env.MD_DATA_DIR; if (!D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const tok = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const staging = path.join(D, 'staging');
const run = () => spawnSync(process.execPath, ['scripts/backup-drive.js', '--keep', '2'], { cwd: ROOT, env: { ...process.env, MD_BACKUP_STAGING: staging }, encoding: 'utf8' });
const { excluded, scanTarball } = require('../scripts/backup-drive');
for (const f of ['.env', 'a/.env.old', 'x.key', 'morning-deck.tail164b96.ts.net.crt', 'run/android/morningdeck.keystore', 'data/cards.json', 'server.js.bak-2026', 'token.json']) assert.ok(excluded(f), f);
for (const f of ['server.js', 'lib/push.js', 'scripts/init-vapid.sh', 'README.md']) assert.ok(!excluded(f), f);
// planted secret is caught
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bk-')); fs.writeFileSync(path.join(t, 'ok.txt'), 'hello'); fs.writeFileSync(path.join(t, 'leak.txt'), 'x SECRETSECRETSECRET123 y');
fs.writeFileSync(path.join(t, 'k.txt'), '-----BEGIN EC ' + 'PRIVATE KEY-----\nabc');
execFileSync('tar', ['-czf', path.join(t, 'a.tgz'), 'ok.txt', 'leak.txt', 'k.txt'], { cwd: t });
assert.strictEqual(scanTarball(path.join(t, 'a.tgz'), ['SECRETSECRETSECRET123']).problems.length, 2);
let r; for (let i = 0; i < 3; i++) { r = run(); assert.strictEqual(r.status, 0, r.stderr); if (i < 2) execFileSync('sleep', ['1.1']); }
assert.ok(!(r.stdout + r.stderr).includes(tok));
const sets = fs.readdirSync(staging).filter((n) => /^\d{4}/.test(n)); assert.strictEqual(sets.length, 2, 'retention keeps newest N');
const set = path.join(staging, fs.readFileSync(path.join(staging, 'LATEST'), 'utf8').trim());
const names = execFileSync('tar', ['-tzf', path.join(set, 'source.tar.gz')]).toString().split('\n');
assert.ok(names.includes('server.js') && names.includes('scripts/restore.sh'));
assert.ok(!names.some((n) => /\.env|\.crt$|\.key$|^data\/|^run\//.test(n)), 'no secrets/data in tarball');
assert.strictEqual(fs.readFileSync(path.join(set, 'cards.json'), 'utf8'), fs.readFileSync(path.join(D, 'cards.json'), 'utf8'));
const m = JSON.parse(fs.readFileSync(path.join(set, 'manifest.json'))); assert.strictEqual(m.driveFolderId, '1Klpu5Yni9GVRtt1aFjLkW0sZxrfJB-Z1');
// restore refuses existing data dir (no clone/network needed for this check)
const tgt = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rs-')); fs.mkdirSync(path.join(tgt, 'data'));
const rs = spawnSync('bash', ['scripts/restore.sh', set, tgt], { cwd: ROOT, encoding: 'utf8' });
assert.notStrictEqual(rs.status, 0); assert.match(rs.stdout + rs.stderr, /verified/); assert.match(rs.stderr, /refusing/);
console.log('backup-drive: all checks passed');
