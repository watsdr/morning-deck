#!/usr/bin/env node
'use strict';
// Nightly off-disk backup, stage step.
//   node scripts/backup-drive.js [--keep 14]
// A plain script on this box has no headless Google Drive credentials (the Drive connector is only available to the
// agent, not to cron/node), so this script STAGES the backup and an agent/scheduler uploads it:
//   run/backup-staging/<YYYY-MM-DD_HHMMSS>/  cards.json  answers.json  source.tar.gz  manifest.json
// manifest.json lists the files, sha256s, the target Drive folder id, and which older Drive copies to trash so only
// the newest 14 remain. Local staging keeps the newest 14 sets too. The source tarball is built from git-tracked +
// untracked-but-not-ignored files, minus secrets, and is then scanned (names AND content); any hit aborts the backup.
// Reads data files only; never writes data/. Prints no secrets.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { execFileSync } = require('child_process');
const core = require('../lib/core');
const ROOT = core.ROOT;
const DRIVE_FOLDER_ID = process.env.MD_DRIVE_FOLDER_ID || '1Klpu5Yni9GVRtt1aFjLkW0sZxrfJB-Z1';
const args = process.argv.slice(2);
const KEEP = +(args.includes('--keep') ? args[args.indexOf('--keep') + 1] : 14);
const STAGING = path.resolve(process.env.MD_BACKUP_STAGING || path.join(ROOT, 'run', 'backup-staging'));
const EXCLUDE = [/(^|\/)\.env(\..*)?$/, /\.key$/i, /\.crt$/i, /\.pem$/i, /\.p12$/i, /\.jks$/i, /keystore/i, /(^|\/)tokens?(\.|\/|$)/i, /token\.(json|txt)$/i, /vapid.*priv/i, /\.bak(-|$)/, /^(data|run|logs|bin|node_modules)\//];
const excluded = (f) => EXCLUDE.some((re) => re.test(f));

function secretsFromEnv() {
  const out = [];
  try {
    for (const line of fs.readFileSync(process.env.MD_ENV_FILE || path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(MD_TOKEN|MD_VAPID_PRIVATE)\s*=\s*['"]?(.*?)['"]?\s*$/);
      if (m && m[2].length >= 16) out.push(m[2]);
    }
  } catch (_) {}
  return out;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stamp = (d) => { const p = core.tzParts(d); const z = (n) => String(n).padStart(2, '0'); return `${p.y}-${z(p.m)}-${z(p.d)}_${z(p.h)}${z(p.mi)}${z(p.s || 0)}`; };

function buildTarball(dest) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean)
    .filter((f) => !excluded(f) && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());
  const list = path.join(os.tmpdir(), `md-tarlist-${process.pid}`);
  fs.writeFileSync(list, files.join('\0'));
  try { execFileSync('tar', ['-czf', dest, '--null', '-T', list], { cwd: ROOT }); } finally { fs.unlinkSync(list); }
  return files;
}
// Scan: every entry name against EXCLUDE, every entry's bytes for the live secrets and private-key markers.
function scanTarball(file, secrets) {
  const problems = [];
  const names = execFileSync('tar', ['-tzf', file]).toString().split('\n').filter(Boolean);
  for (const n of names) if (excluded(n)) problems.push(`excluded name in tarball: ${n}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-scan-'));
  try {
    execFileSync('tar', ['-xzf', file, '-C', tmp]);
    for (const n of names) {
      const p = path.join(tmp, n); if (!fs.statSync(p).isFile()) continue;
      const b = fs.readFileSync(p);
      if (secrets.some((s) => b.includes(s))) problems.push(`live secret value found in ${n}`);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(b.toString('latin1'))) problems.push(`private key block in ${n}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { entries: names.length, problems };
}

function main() {
  const now = new Date();
  core.mkdirPrivate(path.dirname(STAGING)); core.mkdirPrivate(STAGING);
  const name = stamp(now); const dir = path.join(STAGING, name); core.mkdirPrivate(dir);
  const out = [];
  for (const [src, base] of [[core.CARDS_FILE, 'cards.json'], [core.ANSWERS_FILE, 'answers.json']]) {
    const buf = fs.readFileSync(src); JSON.parse(buf); // must be valid JSON
    const title = `morning-deck_${name}_${base}`;
    fs.writeFileSync(path.join(dir, base), buf, { mode: 0o600 });
    out.push({ file: base, driveTitle: title, bytes: buf.length, sha256: sha(buf), mime: 'application/json' });
  }
  const tgz = path.join(dir, 'source.tar.gz');
  const files = buildTarball(tgz); fs.chmodSync(tgz, 0o600);
  const scan = scanTarball(tgz, secretsFromEnv());
  if (scan.problems.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.error(`backup ABORTED, secret scan failed:\n  ${scan.problems.join('\n  ')}`); process.exit(3);
  }
  const t = fs.readFileSync(tgz);
  out.push({ file: 'source.tar.gz', driveTitle: `morning-deck_${name}_source.tar.gz`, bytes: t.length, sha256: sha(t), mime: 'application/gzip', sourceFiles: files.length });
  let commit = ''; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch (_) {}
  // retention (local)
  const sets = fs.readdirSync(STAGING).filter((n) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(n)).sort().reverse();
  for (const old of sets.slice(KEEP)) fs.rmSync(path.join(STAGING, old), { recursive: true, force: true });
  const kept = sets.slice(0, KEEP);
  const manifest = {
    createdAt: now.toISOString(), set: name, gitCommit: commit, driveFolderId: DRIVE_FOLDER_ID, keep: KEEP,
    files: out, secretScan: { entries: scan.entries, problems: 0 },
    upload: `Upload each file into Drive folder ${DRIVE_FOLDER_ID} (by id) with its driveTitle, contentMimeType = mime, disableConversionToGoogleType = true. Then in that folder keep only the newest ${KEEP} sets (titles sort by date: morning-deck_<set>_*) and trash older ones.`,
    keptSets: kept,
  };
  core.writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(STAGING, 'LATEST'), name + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ staged: path.relative(ROOT, dir), files: out.map((f) => `${f.file} ${f.bytes}B`), secretScan: 'clean', sourceFiles: files.length, keptLocalSets: kept.length, driveFolderId: DRIVE_FOLDER_ID, driveUpload: 'pending: needs the agent Drive connector (no headless Drive credentials on this box)' }, null, 2));
}
if (require.main === module) main();
module.exports = { excluded, scanTarball };
