// Unit: lib/waiting.js (Skipped & snoozed). Fixture rows are test-only and marked FIXTURE; nothing touches data/.
//   node test/waiting.js
const assert = require('assert');
const { build } = require('../lib/waiting');
const now = new Date('2026-10-31T14:00:00Z'), d = (n) => new Date(now - n * 86400e3).toISOString();
const card = (id, source, age, extra = {}) => ({ id, source, title: `FIXTURE ${id}`, status: 'pending', createdAt: d(age), receivedAt: d(age), ...extra });
const ans = (cardId, gesture, age, extra = {}) => ({ id: 'a' + Math.random(), cardId, gesture, answeredAt: d(age), ...extra });
const cards = [card('a', 'Chief', 5), card('b', 'Chief', 2), card('c', 'Trip', 9, { status: 'snoozed', snoozedUntil: new Date(+now + 3600e3).toISOString() }),
  card('done', 'Chief', 4, { status: 'answered' }), card('gone', 'Trip', 3, { withdrawn: true }), card('old', 'Trip', 3, { expiresAt: d(1) }), card('s', 'X', 1, { sample: true })];
const answers = [ans('a', 'down', 3), ans('a', 'down', 1), ans('a', 'up', 2), ans('c', 'up', 1), ans('b', 'down', 1, { undone: true }), ans('s', 'down', 0, { sample: true }), ans('done', 'right', 1)];
const r = build(cards, answers, now);
assert.deepStrictEqual(r.passed.map((x) => x.id), ['a', 'c']);
assert.deepStrictEqual([r.passed[0].skips, r.passed[0].snoozes, r.passed[0].daysWaiting], [2, 1, 5]);
assert.ok(r.passed[1].snoozedUntil, 'snoozed card flagged');
assert.deepStrictEqual(r.waiting.map((x) => x.id), ['b'], 'undone skip does not count');
assert.deepStrictEqual(r.bots.map((b) => [b.source, b.open]), [['Chief', 2], ['Trip', 1]]);
assert.strictEqual(r.totals.open, 3); assert.strictEqual(r.totals.skipsRecorded, 2);
assert.ok(!JSON.stringify(r).includes('"s"'), 'samples excluded');
const e = build([], [], now);
assert.deepStrictEqual([e.passed.length, e.bots.length, e.totals.open, e.history.firstAnswer], [0, 0, 0, null]); assert.match(e.history.note, /Oct 17/);
console.log('waiting: ok');
