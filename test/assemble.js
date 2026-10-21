// Isolated test for scripts/assemble.js. Run: node test/isolated.js test/assemble.js
// Writes a fixture cards.json into the temp MD_DATA_DIR, a fixture resolved-items.md, and runs assemble against them.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D || !D.startsWith(os.tmpdir())) { console.error('run via node test/isolated.js'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const tok = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const NOW = new Date('2026-10-21T14:00:00.000Z');
const iso = (h) => new Date(NOW.getTime() + h * 3600e3).toISOString();
const base = (id, o = {}) => ({ id, source: 'Test', title: `Card ${id}`, body: 'x', type: 'question', priority: 'normal', sample: false, status: 'pending', createdAt: iso(-100), receivedAt: iso(-100), ...o });
const cards = [
  base('a-nodue-old', { createdAt: iso(-300) }),
  base('b-due-soon', { dueAt: iso(5) }),
  base('c-overdue', { dueAt: iso(-10), skipCount: 4 }),
  base('d-due-later', { dueAt: iso(50) }),
  base('e-nodue-skips', { createdAt: iso(-200), skipCount: 2 }),
  base('f-nodue-skips-more', { createdAt: iso(-200), skipCount: 5 }),
  base('g-nodue-new', { createdAt: iso(-1) }),
  base('h-snooze-passed', { status: 'snoozed', snoozedUntil: iso(-1), snoozeCount: 1 }),
  base('i-snooze-future', { status: 'snoozed', snoozedUntil: iso(10) }),
  base('j-expired', { expiresAt: iso(-2) }),
  base('k-settled-id'),
  base('l-settled-ref', { body: 'Rental agreement 672166693 renewal reminder' }),
  base('m-settled-kw', { title: 'Your MOVEit claim needs a look' }),
  base('n-nearmiss', { title: 'Set up Gumroad payouts' }),
  base('o-answered', { status: 'answered', answeredAt: iso(-3) }),
  base('p-withdrawn', { withdrawn: true, withdrawnReason: 'old', expiresAt: iso(-50) }),
];
fs.writeFileSync(path.join(D, 'cards.json'), JSON.stringify(cards, null, 2));
const answersBefore = fs.readFileSync(path.join(D, 'answers.json'), 'utf8');
const resolved = path.join(D, 'resolved.md');
fs.writeFileSync(resolved, `# Resolved items\n\n| Item | Date settled | Settled by | Notes |\n|---|---|---|---|\n| MOVEit claim | Oct 8 | Derek | Closed. |\n| Old card thing | Oct 9 | Derek | card k-settled-id-2026-10-01 and k-settled-id |\n| National rental renewal | Oct 20 | Derek | Renewed (RA 672166693). |\n| PayPal Toronto device, Gumroad payout address | Oct 11 | Derek | own activity |\n`);
// k-settled-id needs an id the parser recognizes: give it a dated id
cards[10].id = 'k-settled-id-2026-10-01'; fs.writeFileSync(path.join(D, 'cards.json'), JSON.stringify(cards, null, 2));
const runDir = path.join(D, 'run');
const run = (...a) => { const r = spawnSync(process.execPath, ['scripts/assemble.js', '--resolved', resolved, '--now', NOW.toISOString(), ...a], { cwd: ROOT, env: { ...process.env, MD_RUN_DIR: runDir }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr); assert.ok(!tok || !(r.stdout + r.stderr).includes(tok), 'token never printed'); return JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('}') + 1)); };
(async () => {
  const before = fs.readFileSync(path.join(D, 'cards.json'), 'utf8');
  const dry = run('--dry-run');
  assert.strictEqual(fs.readFileSync(path.join(D, 'cards.json'), 'utf8'), before, 'dry run writes no cards');
  assert.ok(!fs.existsSync(path.join(runDir, 'assemble-last.json')), 'dry run writes no last file');
  const expectTop = ['c-overdue', 'b-due-soon', 'd-due-later', 'a-nodue-old', 'f-nodue-skips-more'];
  assert.deepStrictEqual(dry.top5, expectTop);
  const out = run();
  assert.deepStrictEqual(out.top5, expectTop); assert.strictEqual(out.priorTop5, null); assert.strictEqual(out.changed, true);
  const reasons = Object.fromEntries(out.closed.map((c) => [c.id, c.reason]));
  assert.deepStrictEqual(reasons, { 'j-expired': 'expired', 'k-settled-id-2026-10-01': 'settled: Old card thing', 'l-settled-ref': 'settled: National rental renewal', 'm-settled-kw': 'settled: MOVEit claim' });
  assert.ok(out.nearMisses.some((n) => n.id === 'n-nearmiss'), 'near miss listed, not closed');
  assert.deepStrictEqual(out.unsnoozed, ['h-snooze-passed']);
  assert.deepStrictEqual(out.overdueSkipped3.map((c) => c.id), ['c-overdue']);
  const saved = JSON.parse(fs.readFileSync(path.join(D, 'cards.json'), 'utf8')); const by = Object.fromEntries(saved.map((c) => [c.id, c]));
  assert.strictEqual(by['n-nearmiss'].withdrawn, undefined);
  assert.strictEqual(by['j-expired'].withdrawn, true); assert.strictEqual(by['j-expired'].withdrawnReason, 'expired');
  assert.strictEqual(by['h-snooze-passed'].status, 'pending'); assert.strictEqual(by['i-snooze-future'].status, 'snoozed'); assert.strictEqual(by['i-snooze-future'].rank, undefined);
  assert.strictEqual(by['p-withdrawn'].withdrawnReason, 'old', 'already-withdrawn untouched');
  assert.strictEqual(by['o-answered'].rank, undefined);
  assert.deepStrictEqual(saved.filter((c) => c.aboveFold).sort((a, b) => a.rank - b.rank).map((c) => c.id), expectTop);
  assert.strictEqual(saved.filter((c) => c.aboveFold === false).length, 4);
  assert.strictEqual(fs.readFileSync(path.join(D, 'answers.json'), 'utf8'), answersBefore, 'answers untouched');
  const last = JSON.parse(fs.readFileSync(path.join(runDir, 'assemble-last.json'), 'utf8'));
  assert.deepStrictEqual(last.top5, expectTop);
  const again = run();
  assert.deepStrictEqual(again.priorTop5, expectTop); assert.strictEqual(again.changed, false); assert.deepStrictEqual(again.closed, []);
  // server sees it: withdrawn hidden, aboveFold passed through
  const deck = await (await fetch(`${B}/api/deck`, { headers: { Authorization: `Bearer ${tok}` } })).json();
  assert.ok(!deck.cards.some((c) => c.withdrawn));
  assert.strictEqual(deck.cards.filter((c) => c.aboveFold).length, 5);
  console.log('assemble: ok');
})().catch((e) => { console.error(e.message); process.exit(1); });
