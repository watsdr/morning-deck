// Accessibility + performance audit on a phone viewport against the ISOLATED server (run via test/isolated.js).
//   node test/isolated.js test/audit.js --port 8800     (needs lighthouse + axe-core: AUDIT_MODULES=/path/to/node_modules)
// Prints scores and failing audit ids only; the report itself is never written (its URLs could carry the token).
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const MODS = process.env.AUDIT_MODULES || '/tmp/lh/node_modules';
const B = process.env.MD_BASE; if (!B || /:8787\b/.test(B)) { console.error('isolated server only'); process.exit(2); }
const TOK = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const scrub = (s) => String(s).split(TOK).join('<token>');
(async () => {
  const { chromium } = require('playwright-core');
  const port = 9300 + Math.floor(Math.random() * 500);
  const prof = fs.mkdtempSync('/tmp/md-audit-');
  const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-sandbox', 'about:blank'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const lighthouse = (await import(path.join(MODS, 'lighthouse/core/index.js'))).default;
  const r = await lighthouse(`${B}/?token=${TOK}`, { port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices'], formFactor: 'mobile', screenEmulation: { mobile: true, width: 390, height: 844, deviceScaleFactor: 3, disabled: false } });
  if (r.lhr.runtimeError) console.log('  runtimeError:', scrub(r.lhr.runtimeError.code + ' ' + r.lhr.runtimeError.message));
  if (r.lhr.runWarnings.length) console.log('  warnings:', scrub(r.lhr.runWarnings.join(' / ')).slice(0, 400));
  const c = r.lhr.categories; const sc = (k) => Math.round(c[k].score * 100);
  console.log(`LIGHTHOUSE mobile 390x844: performance ${sc('performance')}, accessibility ${sc('accessibility')}, best-practices ${sc('best-practices')}`);
  for (const k of ['performance', 'accessibility', 'best-practices']) for (const ref of c[k].auditRefs) { const a = r.lhr.audits[ref.id]; if (ref.weight > 0 && a.score !== null && a.score < 0.9) console.log(scrub(`  [${k}] ${ref.id} ${a.score} ${a.displayValue || ''}`)); }
  for (const id of ['first-contentful-paint', 'largest-contentful-paint']) if (r.lhr.audits[id].errorMessage) console.log('  err', id, scrub(r.lhr.audits[id].errorMessage).slice(0, 300));
  for (const id of ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift']) console.log(`  ${id}: ${r.lhr.audits[id].displayValue}`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0]; const page = await ctx.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${B}/?token=${TOK}`, { waitUntil: 'networkidle' }); 
  await page.waitForSelector('.card');
  // axe-core, WCAG 2.x A/AA on the deck view
  await page.addScriptTag({ path: path.join(MODS, 'axe-core/axe.min.js') });
  let fails = 0;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(400);
    const axe = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sel: v.nodes.slice(0, 3).map((x) => x.target.join(' ')) })));
    fails += axe.length;
    console.log(`AXE ${scheme}: ${axe.length} violations`); axe.forEach((v) => console.log(scrub(`  ${v.impact} ${v.id} x${v.n}: ${v.sel.join(' | ')}`)));
  }
  await page.close();
  await browser.close().catch(() => {}); chrome.kill(); await new Promise((r) => setTimeout(r, 500)); try { fs.rmSync(prof, { recursive: true, force: true }); } catch (_) {}
  process.exit(process.env.AUDIT_STRICT && fails ? 1 : 0);
})().catch((e) => { console.error(scrub(e.stack || e)); process.exit(1); });
