#!/usr/bin/env node
// Run a test against a throwaway server: temp data dir (MD_DATA_DIR) + separate port, never the live data/ or 8787.
//   node test/isolated.js test/e2e.js [--empty] [--port 8799]
// Seeds the SAMPLE deck (or nothing with --empty), starts server.js, runs the test with MD_BASE/MD_DATA_DIR set, stops the server.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const port = +(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8799);
const test = args.find((a) => a.endsWith('.js'));
const live = +(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^MD_PORT=(\d+)/m) || [0, 8787])[1];
if (!test) { console.error('usage: node test/isolated.js <test.js> [--empty] [--port N]'); process.exit(2); }
if (port === live) { console.error(`refusing to use the live port ${live}`); process.exit(2); }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-'));
const env = { ...process.env, MD_DATA_DIR: dataDir, MD_PORT: String(port), MD_BASE: `http://127.0.0.1:${port}` };
const seed = args.includes('--empty') ? 'core.saveCards([]);core.saveAnswers([]);'
  : `const s=require('./scripts/sample-cards');const now=new Date();core.saveCards(s(now).map(r=>({...core.validateCard(r,now).card,status:'pending',receivedAt:now.toISOString()})));core.saveAnswers([]);`;
const r = spawnSync(process.execPath, ['-e', `const core=require('./lib/core');if(!core.DATA_DIR.startsWith(${JSON.stringify(dataDir)}))throw new Error('wrong data dir');${seed}`], { cwd: ROOT, env, stdio: 'inherit' });
if (r.status) process.exit(r.status);
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', fs.openSync(path.join(dataDir, 'server.log'), 'a'), fs.openSync(path.join(dataDir, 'server.log'), 'a')] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { if ((await fetch(`${env.MD_BASE}/manifest.webmanifest`)).ok) return; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); } throw new Error('test server did not start'); };
wait().then(() => {
  console.log(`isolated server pid ${srv.pid} on ${env.MD_BASE}, data ${dataDir}`);
  const t = spawn(process.execPath, [test], { cwd: ROOT, env, stdio: 'inherit' });
  t.on('exit', (code) => { srv.kill('SIGTERM'); console.log(`test exit ${code}; data kept in ${dataDir}`); process.exit(code ?? 1); });
}).catch((e) => { console.error(e); srv.kill(); process.exit(2); });
