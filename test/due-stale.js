// Unit test (no server needed): due-today/overdue tier + stale flag in scripts/assemble.js, and the card UI hooks.
// Run: node test/due-stale.js
const assert = require('assert');
const fs = require('fs'), path = require('path');
process.env.MD_DATA_DIR = process.env.MD_DATA_DIR || fs.mkdtempSync(path.join(require('os').tmpdir(), 'md-due-'));
const { assemble } = require('../scripts/assemble.js');
const NOW = new Date('2026-10-22T14:00:00.000Z'); // 10:00 ET
const iso = (h) => new Date(NOW.getTime() + h * 3600e3).toISOString();
const base = (id, o = {}) => ({ id, source: 'T', title: `Card ${id}`, body: 'b', type: 'question', priority: 'normal', sample: false, status: 'pending', createdAt: iso(-10), receivedAt: iso(-10), ...o });
const cards = [
  base('old-nodue', { createdAt: iso(-24 * 9), receivedAt: iso(-24 * 9) }),
  base('due-tonight', { dueAt: iso(11) }),          // 21:00 ET today
  base('overdue', { dueAt: iso(-30) }),
  base('due-tomorrow', { dueAt: iso(20) }),
  base('expires-today', { expiresAt: iso(8) }),     // only expiresAt -> due when it expires
  base('six-days', { createdAt: iso(-24 * 6.9), receivedAt: iso(-24 * 6.9) }),
  base('seven-days', { receivedAt: iso(-24 * 7) , createdAt: iso(-24 * 7) }),
  base('was-stale-answered', { status: 'answered', stale: true, createdAt: iso(-24 * 30) }),
];
const snap = JSON.stringify(cards.map(({ title, body, details }) => ({ title, body, details })));
const r = assemble(cards, [], NOW);
assert.deepStrictEqual(r.top5.slice(0, 3), ['overdue', 'expires-today', 'due-tonight'], 'due today / overdue rank first: ' + r.top5);
assert.deepStrictEqual(r.dueToday.sort(), ['due-tonight', 'expires-today', 'overdue']);
const by = Object.fromEntries(cards.map((c) => [c.id, c]));
assert.strictEqual(by['old-nodue'].stale, true);
assert.strictEqual(by['seven-days'].stale, true);
assert.strictEqual(by['six-days'].stale, undefined);
assert.strictEqual(by['due-tonight'].stale, undefined);
assert.strictEqual(by['was-stale-answered'].stale, undefined, 'answered cards drop the flag');
assert.deepStrictEqual(r.stale.sort(), ['old-nodue', 'seven-days']);
assert.strictEqual(JSON.stringify(cards.map(({ title, body, details }) => ({ title, body, details }))), snap, 'content untouched');
// UI hooks exist
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
assert.ok(app.includes("'Still relevant?'") && app.includes('function dueInfo') && app.includes('due-line'));
console.log('due-stale: ok');
