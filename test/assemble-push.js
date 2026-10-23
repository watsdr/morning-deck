// Isolated test: assemble sends ONE count-only push after its run, suppressed at 0 cards, --no-push / --dry-run skip it.
// Run: node test/isolated.js test/assemble-push.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const D = process.env.MD_DATA_DIR;
if (!D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-10-22T14:00:00.000Z');
const iso = (h) => new Date(NOW.getTime() + h * 3600e3).toISOString();
const base = (id, o = {}) => ({ id, source: 'T', title: `Secret title ${id}`, body: 'b', type: 'question', priority: 'normal', sample: false, status: 'pending', createdAt: iso(-5), receivedAt: iso(-5), ...o });
const cap = path.join(D, 'push-capture.json');
const run = (cards, ...a) => {
  fs.writeFileSync(path.join(D, 'cards.json'), JSON.stringify(cards));
  try { fs.unlinkSync(cap); } catch (_) {}
  const r = spawnSync(process.execPath, ['scripts/assemble.js', '--resolved', '/nonexistent', '--now', NOW.toISOString(), ...a], { cwd: ROOT, env: { ...process.env, MD_RUN_DIR: path.join(D, 'run'), MD_PUSH_CAPTURE: cap }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return fs.existsSync(cap) ? JSON.parse(fs.readFileSync(cap, 'utf8')) : null;
};
const five = [base('a', { dueAt: iso(3) }), base('b'), base('c'), base('d', { dueAt: iso(48) }), base('e'), base('s', { sample: true })];
const p = run(five);
assert.ok(p, 'push sent');
assert.strictEqual(p.body, '5 cards · 1 due today');
assert.strictEqual(p.url, '/');
assert.ok(!JSON.stringify(p).includes('Secret title'), 'no card content in the push');
assert.strictEqual(run([base('x')]).body, '1 card');
assert.strictEqual(run([base('s', { sample: true })]), null, 'suppressed at 0 cards');
assert.strictEqual(run([]), null, 'suppressed at 0 cards (empty)');
assert.strictEqual(run(five, '--no-push'), null);
assert.strictEqual(run(five, '--dry-run'), null);
// real path, no subscriptions in the isolated dir -> skipped, nothing sent
fs.writeFileSync(path.join(D, 'cards.json'), JSON.stringify(five));
const r = spawnSync(process.execPath, ['scripts/assemble.js', '--resolved', '/nonexistent', '--now', NOW.toISOString()], { cwd: ROOT, env: { ...process.env, MD_RUN_DIR: path.join(D, 'run') }, encoding: 'utf8' });
const out = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('}') + 1));
assert.deepStrictEqual(out.push, { skipped: 'no subscriptions' });
assert.ok(!/MD_VAPID_PRIVATE|BEGIN/.test(r.stdout + r.stderr));
console.log('assemble-push: ok');
