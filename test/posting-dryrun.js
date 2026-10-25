// Dry-run every curl example in docs/POSTING-API.md against the ISOLATED server (host rewritten from :8787).
//   node test/isolated.js test/posting-dryrun.js --empty --port 8820
const { execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const B = process.env.MD_BASE; if (!B || /:8787\b/.test(B) || !process.env.MD_DATA_DIR) { console.error('isolated server only'); process.exit(2); }
const TOK = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_TOKEN=(.*)$/m) || [])[1];
const doc = fs.readFileSync(path.join(ROOT, 'docs/POSTING-API.md'), 'utf8');
const blocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('curl'));
const run0 = (b) => execFileSync('bash', ['-c', b.split('http://127.0.0.1:8787').join(B).replace('curl -s', 'curl -s -w "\\nHTTP %{http_code}"')], { env: { ...process.env, MD_TOKEN: TOK }, encoding: 'utf8' }).split(TOK).join('<token>');
const run = (b) => run0(b).replace(/\s+/g, "").replace("HTTP", " HTTP ");
const posts = blocks.filter((b) => b.includes('/api/cards')), reads = blocks.filter((b) => b.includes('/api/answers'));
assert.strictEqual(posts.length, 4, 'four bot examples'); let fail = 0;
for (const b of posts) {
  const first = run(b), again = run(b);
  const ok = /HTTP 20[01]/.test(first) && /"added":\["[^"]+"\]/.test(first) && /"duplicates":\["[^"]+"\]/.test(again);
  if (!ok) fail++; console.log(ok ? 'ok  ' : 'FAIL', first.replace(/\n/g, ' ').slice(0, 160), '| repeat:', again.replace(/\n/g, ' ').slice(0, 100));
}
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' };
(async () => {
  const r = await fetch(`${B}/api/answers`, { method: 'POST', headers: H, body: JSON.stringify({ cardId: 'trip-desk-hotel-hold-2026-10-26', gesture: 'right', clientAnswerId: 'dryrun-1' }) }); // test-only answer on the throwaway server
  assert.ok(r.ok, 'answer recorded on test server');
  for (const b of reads) { const out = run(b); const ok = /HTTP 200/.test(out) && /"count":1/.test(out) && /"value":"keep"/.test(out); if (!ok) fail++; console.log(ok ? 'ok  ' : 'FAIL', 'read answers:', out.replace(/\n/g, ' ').slice(0, 200)); }
  console.log(fail ? `${fail} failed` : 'all POSTING-API.md examples pass'); process.exit(fail ? 1 : 0);
})();
