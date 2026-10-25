// Offline queue + load tests. Run against the ISOLATED server only:  node test/isolated.js test/offline-sync.js --port 8820
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const B = process.env.MD_BASE; if (!B || /:8787\b/.test(B) || !process.env.MD_DATA_DIR) { console.error('isolated server only'); process.exit(2); }
const TOK = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' };
const api = async (p, o = {}) => { const r = await fetch(B + p, { ...o, headers: H }); return { status: r.status, body: await r.json().catch(() => null) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, '\n     ', String(e.message).split(TOK).join('<token>')); } };
const PRACTICE = (i, tag) => ({ source: 'Load Test', sourceId: 'practice-load', id: `practice-${tag}-${i}`, title: `[PRACTICE] load card ${i}`, body: 'Practice card for the load test. Not a real question.', sample: true });

(async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    await t('offline swipes queue, then sync exactly once on reconnect', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(`${B}/?token=${TOK}&tour=0`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.card[data-depth="0"]');
      const before = (await api('/api/answers?all=1')).body.count;
      await ctx.setOffline(true);
      const ids = [];
      for (let i = 0; i < 3; i++) {
        const id = await page.evaluate(() => document.querySelector('.card[data-depth="0"]').dataset.id);
        await page.evaluate(() => window.MorningDeck.swipe('left')); await sleep(700);
        ids.push(id);
      }
      const q = await page.evaluate(() => JSON.parse(localStorage.getItem('md_outbox_v1') || '[]'));
      assert.deepStrictEqual(q.map((p) => p.cardId).sort(), [...ids].sort(), 'all 3 answers queued on the phone');
      assert.ok(q.every((p) => p.clientAnswerId), 'each queued answer has a clientAnswerId');
      assert.strictEqual((await api('/api/answers?all=1')).body.count, before, 'nothing reached the server while offline');
      await ctx.setOffline(false);
      // Hostile reconnect: online event + manual flushes racing + a reload that flushes again on boot.
      await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.MorningDeck.flushOutbox(); window.MorningDeck.flushOutbox(); });
      await page.reload({ waitUntil: 'networkidle' }); await page.evaluate(() => window.MorningDeck.flushOutbox()); await sleep(1500);
      const left = await page.evaluate(() => JSON.parse(localStorage.getItem('md_outbox_v1') || '[]').length);
      assert.strictEqual(left, 0, 'outbox drained');
      const all = (await api('/api/answers?all=1')).body.answers;
      for (const id of ids) assert.strictEqual(all.filter((a) => a.cardId === id).length, 1, `exactly one answer for ${id}`);
      const cids = all.map((a) => a.clientAnswerId).filter(Boolean);
      assert.strictEqual(new Set(cids).size, cids.length, 'no clientAnswerId recorded twice');
      // replaying a queued payload by hand is a no-op
      const rep = await api('/api/answers', { method: 'POST', body: JSON.stringify(q[0]) });
      assert.strictEqual(rep.status, 200); assert.strictEqual(rep.body.duplicate, true);
      assert.strictEqual((await api('/api/answers?all=1')).body.count, all.length, 'replay added nothing');
      await ctx.close();
    });

    await t('load: 200 practice cards posted concurrently, duplicates rejected', async () => {
      const t0 = Date.now();
      const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => api('/api/cards', { method: 'POST', body: JSON.stringify(PRACTICE(i % 100, 'a')) })));
      const ms = Date.now() - t0;
      assert.ok(rs.every((r) => r.status === 200 || r.status === 201), 'all requests accepted: ' + [...new Set(rs.map((r) => r.status))]);
      const added = rs.reduce((n, r) => n + (r.body.added || []).length, 0), dups = rs.reduce((n, r) => n + (r.body.duplicates || []).length, 0);
      assert.strictEqual(added, 100, `100 unique added (got ${added})`); assert.strictEqual(dups, 100, `100 duplicates (got ${dups})`);
      console.log(`      200 concurrent POST /api/cards in ${ms} ms`);
    });

    await t('load: 100 answers x3 concurrent retries with the same clientAnswerId record once each', async () => {
      const t0 = Date.now();
      const reqs = [];
      for (let i = 0; i < 100; i++) for (let k = 0; k < 3; k++) reqs.push(api('/api/answers', { method: 'POST', body: JSON.stringify({ cardId: `practice-a-${i}`, gesture: 'left', clientAnswerId: `load-${i}` }) }));
      const rs = await Promise.all(reqs); const ms = Date.now() - t0;
      assert.ok(rs.every((r) => r.status === 200 || r.status === 201), 'statuses ' + [...new Set(rs.map((r) => r.status))]);
      const got = (await api('/api/answers?source=Load%20Test&all=1')).body.answers;
      assert.strictEqual(got.length, 100, `100 answers (got ${got.length})`);
      assert.strictEqual(rs.filter((r) => r.body.duplicate).length, 200, '200 duplicates flagged');
      console.log(`      300 concurrent POST /api/answers in ${ms} ms`);
      const d0 = Date.now(); for (let i = 0; i < 20; i++) assert.strictEqual((await api('/api/deck')).status, 200);
      console.log(`      GET /api/deck avg ${Math.round((Date.now() - d0) / 20)} ms with ${got.length} answers stored`);
    });
  } finally { await browser.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
