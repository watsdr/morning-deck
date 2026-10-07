// API checks: feedback card on an empty deck, stays last, one per day; upload validation + auth.
// Usage: node test/isolated.js test/api.js --empty
const fs = require('fs'); const path = require('path');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE;
if (!BASE || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
const H = { Authorization: `Bearer ${env.MD_TOKEN}` };
const call = async (p, o = {}) => { const r = await fetch(BASE + p, { ...o, headers: { ...H, ...(o.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = (p, b) => call(p, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const FB = `morningdeck-feedback-${today}`;
let bad = 0; const ok = (n, c, i) => { if (!c) bad++; console.log(c ? 'PASS' : 'FAIL', n, i !== undefined ? JSON.stringify(i) : ''); };
(async () => {
  let d = (await call('/api/deck')).body;
  ok('emptyDeckHasOnlyFeedback', d.count === 1 && d.cards[0].id === FB, d.cards.map((c) => c.id));
  ok('cardsJsonUntouched', (await call('/api/cards')).body.cards.length === 0);
  await post('/api/cards', [{ id: 'a-high', source: 'A', title: 'high', priority: 'high' }, { id: 'b-low', source: 'B', title: 'low', priority: 'low', createdAt: new Date(Date.now() + 3600e3).toISOString() }]);
  d = (await call('/api/deck')).body;
  ok('feedbackLast', d.cards.map((c) => c.id).join() === `a-high,b-low,${FB}`, d.cards.map((c) => c.id));
  const s = await post('/api/answers', { cardId: FB, gesture: 'down' });
  ok('skipRecorded', s.status === 201 && s.body.answer.source === 'Morning Deck' && s.body.answer.value === 'skip' && s.body.answer.replyTo.bot === 'morning-deck', s.body.answer);
  ok('goneAfterSkip', !(await call('/api/deck')).body.cards.some((c) => c.id === FB));
  ok('answerAgain409', (await post('/api/answers', { cardId: FB, gesture: 'right' })).status === 409);
  ok('tomorrowNotAnswerable', (await post('/api/answers', { cardId: 'morningdeck-feedback-2999-01-01', gesture: 'right' })).status === 404);
  const u = await post('/api/answers/undo', { cardId: FB });
  ok('undoBringsItBack', u.status === 201 && (await call('/api/deck')).body.cards.slice(-1)[0].id === FB);
  const svg = await call('/api/uploads', { method: 'POST', body: '<svg xmlns="http://www.w3.org/2000/svg"/>', headers: { 'Content-Type': 'image/svg+xml' } });
  ok('svgRejected415', svg.status === 415, svg.body);
  const big = await call('/api/uploads', { method: 'POST', body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8.5 * 1048576)]), headers: { 'Content-Type': 'image/jpeg' } });
  ok('over8MB413', big.status === 413, big.body);
  const noauth = await fetch(BASE + '/api/uploads', { method: 'POST', body: 'x' });
  ok('uploadNeedsAuth', noauth.status === 401);
  ok('unknownAttachment400', (await post('/api/answers', { cardId: 'a-high', gesture: 'tap3', attachments: ['upl_00000000000000000000'] })).status === 400);
  ok('tap3NeedsTextOrPhoto', (await post('/api/answers', { cardId: 'a-high', gesture: 'tap3' })).status === 400);
  process.exit(bad ? 1 : 0);
})();
