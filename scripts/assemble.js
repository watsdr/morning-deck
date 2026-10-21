#!/usr/bin/env node
'use strict';
// Assemble the morning deck: un-snooze, withdraw expired/settled cards, rank pending cards, mark the top 5 aboveFold.
//   node scripts/assemble.js [--dry-run] [--resolved FILE] [--now ISO]
// Writes cards only through core.withLock + core.saveCards (atomic tmp+fsync+rename, daily backup). Never reads or
// writes answers.json and never records answers. Prints no secrets. MD_DATA_DIR selects the data dir (tests).
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const DRY = args.includes('--dry-run');
const RESOLVED = path.resolve(opt('--resolved', process.env.MD_RESOLVED_FILE || '/workspace/shared/resolved-items.md'));
const RUN_DIR = path.resolve(process.env.MD_RUN_DIR || path.join(core.ROOT, 'run'));
const LAST_FILE = path.join(RUN_DIR, 'assemble-last.json');
const NOW = opt('--now') ? new Date(opt('--now')) : new Date();
const TOP_N = 5;

// ---------- resolved-items.md ----------
const STOP = new Set(['claim', 'closed', 'device', 'account', 'alerts', 'sign', 'signin', 'chrome', 'mobile', 'rental', 'conflict', 'address', 'renewal', 'lodging', 'settled', 'derek', 'recorded', 'chief', 'staff', 'their', 'there', 'these', 'three', 'which', 'would', 'about']);
function parseResolved(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!/^\|/.test(line) || /^\|\s*-/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((s) => s.trim());
    if (!cells[0] || /^item$/i.test(cells[0])) continue;
    const item = cells[0], all = cells.join(' | ');
    const ids = [...all.matchAll(/\b([a-z][a-z0-9]*-[a-z0-9-]*\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]);
    const refs = [...all.matchAll(/\b(?:RA|ref|#)\s*#?\s*(\d{5,})\b/gi)].map((m) => m[1]);
    // phrases: the item split on commas / slashes, with parentheticals removed
    const phrases = item.replace(/\([^)]*\)/g, '').split(/,|\/|\band\b/).map((s) => s.trim().toLowerCase()).filter((s) => s.split(/\s+/).length >= 2);
    const words = [...new Set(item.replace(/\([^)]*\)/g, ' ').toLowerCase().match(/[a-z0-9+]{5,}/g) || [])].filter((w) => !STOP.has(w));
    rows.push({ item, ids, refs, phrases, words });
  }
  return rows;
}
const cardText = (c) => [c.id, c.sourceId, c.title, c.body, c.details, ...(c.tags || [])].filter(Boolean).join(' ').toLowerCase();
function matchResolved(card, rows) {
  const t = cardText(card), near = [];
  for (const r of rows) {
    if (r.ids.includes(card.id) || (card.sourceId && r.ids.includes(card.sourceId))) return { match: r, why: `card id ${card.id}` };
    const ref = r.refs.find((n) => new RegExp(`\\b${n}\\b`).test(t)); if (ref) return { match: r, why: `ref ${ref}` };
    const ph = r.phrases.find((p) => t.includes(p)); if (ph) return { match: r, why: `keyword "${ph}"` };
    const w = r.words.filter((x) => new RegExp(`\\b${x}`).test(t));
    if (w.length) near.push({ item: r.item, words: w });
  }
  return { near };
}

// ---------- ranking ----------
const dueOf = (c) => { const v = c.dueAt || c.due; const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? Infinity : t; };
const ageOf = (c) => Date.parse(c.createdAt || c.receivedAt || 0) || 0;
function rankCmp(a, b) {
  const da = dueOf(a), db = dueOf(b);
  return (da === db ? 0 : da < db ? -1 : 1) || ageOf(a) - ageOf(b) || (b.skipCount || 0) - (a.skipCount || 0) || a.id.localeCompare(b.id);
}

function assemble(cards, rows, now) {
  const closed = [], unsnoozed = [], nearMisses = [];
  for (const c of cards) {
    if (c.status === 'answered' || c.withdrawn) continue;
    // 1) snooze passed -> pending
    if (c.status === 'snoozed' && (!c.snoozedUntil || Date.parse(c.snoozedUntil) <= now.getTime())) {
      c.status = 'pending'; delete c.snoozedUntil; unsnoozed.push(c.id);
    }
    // 2) expired / settled -> withdrawn
    if (c.expiresAt && Date.parse(c.expiresAt) <= now.getTime()) {
      c.withdrawn = true; c.withdrawnReason = 'expired'; c.withdrawnAt = now.toISOString(); closed.push({ id: c.id, title: c.title, reason: 'expired' }); continue;
    }
    const m = matchResolved(c, rows);
    if (m.match) {
      const reason = `settled: ${m.match.item}`;
      c.withdrawn = true; c.withdrawnReason = reason; c.withdrawnAt = now.toISOString(); closed.push({ id: c.id, title: c.title, reason, matchedOn: m.why }); continue;
    }
    for (const n of m.near) nearMisses.push({ id: c.id, title: c.title, item: n.item, sharedWords: n.words });
  }
  // 3) rank pending (non-snoozed) cards
  const pend = cards.filter((c) => !c.sample && core.isPending(c, now)).sort(rankCmp);
  pend.forEach((c, i) => { c.rank = i + 1; c.aboveFold = i < TOP_N; });
  for (const c of cards) if (!pend.includes(c) && (c.rank !== undefined || c.aboveFold !== undefined)) { delete c.rank; delete c.aboveFold; }
  const overdueSkipped3 = pend.filter((c) => dueOf(c) <= now.getTime() && (c.skipCount || 0) >= 3).map((c) => ({ id: c.id, title: c.title, due: c.dueAt || c.due, skipCount: c.skipCount }));
  return { top5: pend.slice(0, TOP_N).map((c) => c.id), pendingCount: pend.length, closed, unsnoozed, nearMisses, overdueSkipped3 };
}

async function main() {
  const rows = parseResolved(RESOLVED);
  let prior = null; try { prior = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch (_) {}
  const result = await core.withLock(() => {
    const before = fs.readFileSync(core.CARDS_FILE, 'utf8');
    const cards = JSON.parse(before);
    const r = assemble(cards, rows, NOW);
    r.cardsChanged = JSON.stringify(cards) !== JSON.stringify(JSON.parse(before));
    if (!DRY && r.cardsChanged) {
      // cross-process guard: the server's lock is in-process, so refuse to save if cards.json moved under us
      if (fs.readFileSync(core.CARDS_FILE, 'utf8') !== before) throw new Error('cards.json changed during assemble; nothing saved, re-run');
      core.saveCards(cards);
    }
    return r;
  });
  const priorTop5 = prior && Array.isArray(prior.top5) ? prior.top5 : null;
  const out = {
    time: NOW.toISOString(), dryRun: DRY, top5: result.top5, priorTop5,
    closed: result.closed, unsnoozed: result.unsnoozed, overdueSkipped3: result.overdueSkipped3, nearMisses: result.nearMisses,
    pendingCount: result.pendingCount,
    changed: result.cardsChanged || JSON.stringify(result.top5) !== JSON.stringify(priorTop5 || []),
  };
  if (!DRY) { core.mkdirPrivate(RUN_DIR); core.writeJsonAtomic(LAST_FILE, out); }
  console.log(JSON.stringify(out, null, 2));
  if (DRY) console.log(`(dry run: cards.json and ${path.relative(process.cwd(), LAST_FILE)} not written)`);
}
if (require.main === module) main().catch((e) => { console.error(`assemble failed: ${e.message}`); process.exit(1); });
module.exports = { parseResolved, matchResolved, assemble, rankCmp };
