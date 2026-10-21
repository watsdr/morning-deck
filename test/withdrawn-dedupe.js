// Isolated test: POST /api/cards dedupes by id, and withdrawn cards never reach /api/deck.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D) { console.error('run via node test/isolated.js'); process.exit(2); }
const tok = (fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
(async () => {
  const card = { id: 'test-dedupe-1', source: 'Test', title: 'Dedupe test', body: 'x', type: 'info', priority: 'normal' };
  let r = await fetch(`${B}/api/cards`, { method: 'POST', headers: H, body: JSON.stringify(card) });
  assert.strictEqual(r.status, 201, 'first post adds');
  r = await fetch(`${B}/api/cards`, { method: 'POST', headers: H, body: JSON.stringify(card) });
  const j = await r.json(); assert.deepStrictEqual(j.duplicates, ['test-dedupe-1']); assert.deepStrictEqual(j.added, []);
  const all = (await (await fetch(`${B}/api/cards`, { headers: H })).json()).cards.filter((c) => c.id === card.id);
  assert.strictEqual(all.length, 1, 'no duplicate stored');
  const deck1 = await (await fetch(`${B}/api/deck`, { headers: H })).json();
  assert.ok(deck1.cards.some((c) => c.id === card.id));
  const f = path.join(D, 'cards.json'); const cs = JSON.parse(fs.readFileSync(f, 'utf8'));
  cs.find((c) => c.id === card.id).withdrawn = true; fs.writeFileSync(f, JSON.stringify(cs));
  const deck2 = await (await fetch(`${B}/api/deck`, { headers: H })).json();
  assert.ok(!deck2.cards.some((c) => c.id === card.id), 'withdrawn card hidden');
  assert.strictEqual(deck2.count, deck1.count - 1);
  console.log('withdrawn-dedupe: ok');
})().catch((e) => { console.error(e.message); process.exit(1); });
