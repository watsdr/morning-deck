// Insights checks (isolated): auth like /api/deck, honest empty state, read-only, fake history ranking, skip counter.
// Usage: node test/isolated.js test/insights.js --empty
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE, DATA = process.env.MD_DATA_DIR;
if (!BASE || !DATA || !DATA.startsWith(os.tmpdir()) || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via test/isolated.js'); process.exit(2); }
const H = { Authorization: `Bearer ${env.MD_TOKEN}` };
const call = async (p, o = {}) => { const r = await fetch(BASE + p, { ...o, headers: { ...H, ...(o.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = (p, b) => call(p, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } });
const hash = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return 'missing'; } };
let bad = 0; const ok = (n, c, i) => { if (!c) bad++; console.log(c ? 'PASS' : 'FAIL', n, i !== undefined ? JSON.stringify(i) : ''); };
(async () => {
  // auth
  ok('noAuth401', (await fetch(BASE + '/api/insights')).status === 401);
  ok('queryTokenRejected', (await fetch(BASE + '/api/insights?token=' + encodeURIComponent(env.MD_TOKEN))).status === 401);
  ok('wrongBearer401', (await fetch(BASE + '/api/insights', { headers: { Authorization: 'Bearer nope' } })).status === 401);
  const login = await fetch(BASE + '/?token=' + encodeURIComponent(env.MD_TOKEN), { redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok('cookieWorks', cookie && (await fetch(BASE + '/api/insights', { headers: { Cookie: cookie } })).status === 200);
  ok('postNotAllowed', (await post('/api/insights', {})).status === 404);
  // empty state
  let r = (await call('/api/insights')).body;
  ok('emptyHonest', r.summary.pending === 0 && r.attention.length === 0 && r.history.answerRecords === 0 && r.series.every((d) => !d.answered && !d.skipped && !d.snoozed), r.summary);
  ok('emptyNoCoverageBeforeRecords', r.series.filter((d) => d.covered).length <= 1, r.history);
  ok('emptyStreakZeroOrToday', r.summary.clearedStreak <= 1 && r.summary.oldestPendingDays === null);
  // fake history
  require('./insights-fixture')(DATA);
  const before = [hash(path.join(DATA, 'cards.json')), hash(path.join(DATA, 'answers.json'))];
  r = (await call('/api/insights')).body;
  ok('readOnly', before.join() === [hash(path.join(DATA, 'cards.json')), hash(path.join(DATA, 'answers.json'))].join());
  ok('topIsMostSnoozed', r.attention[0].id === 'fake-gutters-1' && r.attention[0].snoozes === 4, r.attention.map((a) => [a.id, a.score]));
  const by = Object.fromEntries(r.attention.map((a) => [a.id, a]));
  ok('skipsFromAnswers', by['fake-dentist-3'] && by['fake-dentist-3'].skips === 2);
  ok('undoneIgnored', !by['fake-done-7'] && r.series.reduce((n, d) => n + d.skipped, 0) === 2, r.series.map((d) => d.skipped));
  ok('overdueFlagged', by['fake-trip-5'] && by['fake-trip-5'].overdue && by['fake-trip-5'].status === 'overdue');
  ok('dueSoonFlagged', by['fake-renew-2'].dueSoon && by['fake-dentist-3'].dueSoon && r.dueSoon.includes('fake-trip-5'));
  ok('perBot', r.byBot[0].source === 'Fake Home Bot' && r.byBot[0].open === 2, r.byBot);
  ok('summary', r.summary.pending === 5 && r.summary.oldestPendingDays === 9 && r.summary.overdue === 1, r.summary);
  ok('series14', r.series.length === 14 && r.series.reduce((n, d) => n + d.snoozed, 0) === 6 && r.series.reduce((n, d) => n + d.answered, 0) === 1);
  ok('stripHasHotDays', by['fake-gutters-1'].strip.filter((x) => x === 2).length === 4, by['fake-gutters-1'].strip);
  ok('streakZeroWithOpenCards', r.summary.clearedStreak === 0);
  // additive skip counter through the app's save path, and undo reverts it
  const s = await post('/api/answers', { cardId: 'fake-wifi-4', gesture: 'down' });
  let c = JSON.parse(fs.readFileSync(path.join(DATA, 'cards.json'))).find((x) => x.id === 'fake-wifi-4');
  ok('skipCounter', s.status === 201 && c.skipCount === 1 && c.status === 'answered' && c.lastSkippedAt, c);
  await post('/api/answers/undo', { answerId: s.body.answer.id });
  c = JSON.parse(fs.readFileSync(path.join(DATA, 'cards.json'))).find((x) => x.id === 'fake-wifi-4');
  ok('undoRevertsCounter', c.skipCount === 0 && c.status === 'pending', c);
  // cleared streak: answer everything -> today cleared
  for (const id of ['fake-gutters-1', 'fake-renew-2', 'fake-dentist-3', 'fake-wifi-4', 'fake-news-6']) await post('/api/answers', { cardId: id, gesture: 'right' });
  r = (await call('/api/insights')).body;
  ok('clearedToday', r.summary.pending === 0 && r.summary.clearedStreak >= 1, r.summary);
  // UI is wired
  const html = await (await fetch(BASE + '/', { headers: { Cookie: cookie } })).text();
  const js = await (await fetch(BASE + '/app.js', { headers: { Cookie: cookie } })).text();
  const sw = await (await fetch(BASE + '/sw.js')).text();
  ok('uiWired', html.includes('id="insightsBtn"') && html.includes('id="insightsRowBtn"') && js.includes("'/api/insights'") && /md-v(\d+)/.exec(sw)[1] >= 11);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
