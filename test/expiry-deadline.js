// Regression: card "GitHub needs 2FA by Nov 27" was posted with expiresAt 2026-10-31 06:00 ET and assemble withdrew it
// on Oct 31, four weeks before its stated deadline. Expiry must never precede dueAt or a "by <date>" in the title/body.
const assert = require('assert');
const core = require('../lib/core');
const { assemble } = require('../scripts/assemble');
const mk = (o) => ({ id: 'cos-github-2fa-2026-10-14', source: 'Chief of Staff', type: 'question', priority: 'normal', sample: false, status: 'pending',
  title: 'GitHub needs 2FA by Nov 27', body: 'GitHub requires two-factor sign-in by Nov 27, 7 PM ET.', createdAt: '2026-10-18T01:20:00.000Z', expiresAt: '2026-10-31T10:00:00.000Z', ...o });
const at = (s) => new Date(s);
// stated deadline = end of Nov 27 ET
assert.strictEqual(new Date(core.statedDeadline(mk())).toISOString(), '2026-11-28T04:59:59.999Z');
// the Oct 31 assemble keeps it
let c = mk(); let out = assemble([c], [], at('2026-10-31T10:18:09.234Z'));
assert.ok(!c.withdrawn, 'not withdrawn on Oct 31'); assert.deepStrictEqual(out.closed, []); assert.ok(out.top5.includes(c.id));
assert.ok(core.isPending(c, at('2026-11-27T23:00:00Z')), 'still pending on Nov 27 evening ET');
// after the deadline it expires
c = mk(); out = assemble([c], [], at('2026-11-28T06:00:00Z')); assert.strictEqual(c.withdrawnReason, 'expired');
// dueAt later than expiresAt also wins
c = mk({ title: 'Plain card', body: 'x', dueAt: '2026-11-10T12:00:00Z' }); assemble([c], [], at('2026-11-01T12:00:00Z')); assert.ok(!c.withdrawn);
// plain expiresAt with no deadline still expires as before
c = mk({ title: 'Plain card', body: 'no date' }); assemble([c], [], at('2026-10-31T10:18:00Z')); assert.strictEqual(c.withdrawnReason, 'expired');
// year rollover: posted Dec 20, "by Jan 5" means next year
assert.strictEqual(new Date(core.statedDeadline(mk({ title: 'Renew by Jan 5', createdAt: '2026-12-20T12:00:00Z' }))).toISOString().slice(0, 10), '2027-01-06');
console.log('expiry-deadline: all checks passed');
