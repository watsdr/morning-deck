#!/usr/bin/env node
// npm test: runs each suite against its own isolated server (temp data dir) on port 8811 (MD_TEST_PORT overrides;
// if 8811 is busy, the next free port up to 8821 (never 8787/8799/8800) is used and reported). Never touches 8787 or data/.
const { spawnSync } = require('child_process');
const net = require('net');
const SUITES = [['test/pass1.js', '--empty'], ['test/device-approval.js', '--empty'], ['test/qr-pairing.js', '--empty'], ['test/backups.js', '--empty'], ['test/offline-sync.js'], ['test/request-log.js', '--empty'], ['test/expiry-deadline.js', '--empty'], ['test/stay-signed-in.js', '--empty']];
const free = (p) => new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
(async () => {
  let port = +(process.env.MD_TEST_PORT || 8811);
  while (!(await free(port))) { if (port >= 8821) { console.error('no free test port 8811-8821'); process.exit(2); } console.log(`port ${port} busy, trying ${port + 1}`); port++; }
  const out = [];
  for (const [file, ...flags] of SUITES) {
    console.log(`\n=== ${file} (port ${port})`);
    const r = spawnSync(process.execPath, ['test/isolated.js', file, ...flags, '--port', String(port)], { stdio: 'inherit' });
    out.push([file, r.status === 0 ? 'PASS' : 'FAIL']);
  }
  console.log('\n' + out.map((o) => `${o[1]}  ${o[0]}`).join('\n'));
  const bad = out.filter((o) => o[1] === 'FAIL').length;
  console.log(`suites: ${out.length - bad} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})();
