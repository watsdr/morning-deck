// 390x844 screenshots of the 'More (N)' divider on fixture data. Run: node test/isolated.js test/screens-assemble.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const B = process.env.MD_BASE, D = process.env.MD_DATA_DIR;
if (!B || !D || !D.startsWith(os.tmpdir())) { console.error('run via test/isolated.js'); process.exit(2); }
const tok = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const OUT = path.join(ROOT, 'run', 'screens-assemble');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // seeded SAMPLE cards are marked non-sample in this temp copy so assemble ranks them
  const f = path.join(D, 'cards.json'); fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')).map((c) => ({ ...c, sample: false }))
    .concat(['Renew the parking permit?', 'Book the dentist cleaning?', 'Reply to the landlord about the lease?'].map((t, i) => ({ id: `fixture-extra-${i}`, source: 'Fixture Bot', emoji: '📌', title: t, body: 'Fixture card for the More divider screenshot.', type: 'question', priority: 'low', sample: false, status: 'pending', createdAt: new Date().toISOString(), receivedAt: new Date().toISOString() })))));
  const r = spawnSync(process.execPath, ['scripts/assemble.js', '--resolved', path.join(D, 'none.md')], { cwd: ROOT, env: { ...process.env, MD_RUN_DIR: path.join(D, 'run') }, encoding: 'utf8' });
  if (r.status) throw new Error(r.stderr);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  await page.goto(`${B}/?token=${tok}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"][data-id]'); await sleep(1000);
  const ids = await page.evaluate(() => window.MorningDeck.state.deck.map((c) => c.id));
  if (ids[5] !== 'md-more-divider') throw new Error('divider not 6th: ' + ids.join(','));
  // swipe past the top 5 to bring the divider to the front (UI only state: drop them locally, no answers recorded)
  await page.evaluate(() => { const s = window.MorningDeck.state; s.deck.splice(0, 5); });
  await page.evaluate(() => window.MorningDeck.render && window.MorningDeck.render());
  await page.waitForSelector('.card-divider[data-depth="0"]'); await sleep(800);
  const p = path.join(OUT, 'more-divider.png'); await page.screenshot({ path: p }); console.log(p);
  await page.click('.card-divider'); await sleep(900);
  const after = await page.evaluate(() => window.MorningDeck.state.deck.map((c) => c.id));
  if (after.includes('md-more-divider') || !after.length) throw new Error('divider did not open');
  const p2 = path.join(OUT, 'more-opened.png'); await page.screenshot({ path: p2 }); console.log(p2, `revealed ${after.length} cards`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
