'use strict';
// Insights: read-only, at-a-glance stats computed from cards.json, answers.json and the daily backups in
// data/backups/ (plus the off-box mirror). Never writes anything and never invents data: days with no records are
// reported as `covered: false` so the UI can show an honest empty state.
const fs = require('fs');
const path = require('path');
const core = require('./core');

const DAY = 864e5;
const real = (c) => c && !c.sample && !c.builtin;
function readList(file) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
// All backup files of a kind across the local dir and the mirror, one per date (local wins): [{date, file}] oldest first.
function backupFiles(kind) {
  const re = new RegExp(`^${kind}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  const byDate = new Map();
  for (const dir of [core.MIRROR_DIR, core.BACKUP_DIR].filter(Boolean)) {
    let names = []; try { names = fs.readdirSync(dir); } catch (_) {}
    for (const n of names) { const m = re.exec(n); if (m) byDate.set(m[1], path.join(dir, n)); }
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, file]) => ({ date, file }));
}
function addDays(dateStr, n) { const [y, m, d] = dateStr.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
const isSkip = (a) => a.gesture === 'down';
const isSnooze = (a) => a.gesture === 'up' && !!a.snoozedUntil;

function compute({ cards = core.loadCards(), answers = core.loadAnswers(), now = new Date(), days = 14 } = {}) {
  const today = core.etDate(now);
  const nowMs = now.getTime();
  const cardBackups = backupFiles('cards').map((b) => ({ date: b.date, cards: readList(b.file) }));
  const answerBackups = backupFiles('answers').map((b) => ({ date: b.date, answers: readList(b.file) }));

  // Every answer we still have a record of (live + backups), deduped by id; the live copy wins (it carries `undone`).
  const ans = new Map();
  for (const b of answerBackups) for (const a of b.answers) if (a && a.id) ans.set(a.id, a);
  for (const a of answers) if (a && a.id) ans.set(a.id, a);
  const undoneIds = new Set([...ans.values()].filter((a) => a.gesture === 'undo' && a.undoes).map((a) => a.undoes));
  const allAnswers = [...ans.values()].filter((a) => a.gesture !== 'undo' && !a.undone && !undoneIds.has(a.id) && !a.sample && !a.builtin && !core.FEEDBACK_RE.test(a.cardId || ''));

  // Every card we know of (backups oldest -> newest, then live). firstSeen = earliest backup date it appears in.
  const known = new Map(), firstSeen = new Map();
  for (const b of cardBackups) for (const c of b.cards) if (real(c) && c.id) { known.set(c.id, c); if (!firstSeen.has(c.id)) firstSeen.set(c.id, b.date); }
  for (const c of cards) if (real(c) && c.id) known.set(c.id, c);
  const liveIds = new Set(cards.map((c) => c.id));

  // History coverage: the earliest day for which any record exists. Anything before it is "no data", not zero.
  const recordDates = [...cardBackups.map((b) => b.date), ...answerBackups.map((b) => b.date), ...allAnswers.map((a) => core.etDate(new Date(a.answeredAt || a.recordedAt)))];
  const historyStart = recordDates.length ? recordDates.sort()[0] : (cards.length ? today : null);

  const perCard = new Map();
  const stat = (id) => { if (!perCard.has(id)) perCard.set(id, { skips: 0, snoozes: 0, answers: 0, lastAt: null }); return perCard.get(id); };
  for (const a of allAnswers) {
    const s = stat(a.cardId);
    if (isSkip(a)) s.skips++; else if (isSnooze(a)) s.snoozes++; else s.answers++;
    const t = a.answeredAt || a.recordedAt; if (!s.lastAt || t > s.lastAt) s.lastAt = t;
  }

  // Per-day series (ET days), oldest first.
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    series.push({ date, covered: !!historyStart && date >= historyStart, answered: 0, skipped: 0, snoozed: 0, new: 0 });
  }
  const idx = new Map(series.map((d, i) => [d.date, i]));
  for (const a of allAnswers) {
    const i = idx.get(core.etDate(new Date(a.answeredAt || a.recordedAt))); if (i === undefined) continue;
    if (isSkip(a)) series[i].skipped++; else if (isSnooze(a)) series[i].snoozed++; else series[i].answered++;
  }
  for (const c of known.values()) {
    const t = c.receivedAt || c.createdAt; if (!t) continue;
    const i = idx.get(core.etDate(new Date(t))); if (i !== undefined && series[i].covered) series[i].new++;
  }

  const pendingCards = cards.filter((c) => real(c) && core.isPending(c, now));
  const snoozedCards = cards.filter((c) => real(c) && c.status === 'snoozed' && !core.isPending(c, now) && !(c.expiresAt && Date.parse(c.expiresAt) <= nowMs));
  const openCards = [...pendingCards, ...snoozedCards];
  const since = (c) => Math.min(...[c.createdAt, c.receivedAt, firstSeen.get(c.id) && core.etDayBounds(firstSeen.get(c.id)).start.toISOString()].filter(Boolean).map(Date.parse));
  const ageDays = (c) => Math.max(0, (nowMs - since(c)) / DAY);

  // Overdue = expired without an answer (in the last 14 days, still in cards.json or a backup).
  const overdueCards = [...known.values()].filter((c) => c.status !== 'answered' && c.expiresAt && Date.parse(c.expiresAt) <= nowMs && nowMs - Date.parse(c.expiresAt) < days * DAY && !(stat(c.id).answers || stat(c.id).skips));

  const row = (c, state) => {
    const s = perCard.get(c.id) || { skips: 0, snoozes: 0 };
    const skips = Math.max(s.skips, c.skipCount || 0), snoozes = Math.max(s.snoozes, c.snoozeCount || 0);
    const age = ageDays(c);
    const due = c.expiresAt || null, dueMs = due ? Date.parse(due) : null;
    const overdue = state === 'overdue';
    const dueSoon = !overdue && dueMs !== null && dueMs - nowMs < 48 * 3600e3;
    // Pending-day strip: one cell per covered day the card was open (from the daily backups + today).
    const strip = series.map((d) => {
      if (!d.covered) return null;
      const start = core.etDayBounds(d.date).start.getTime(), end = core.etDayBounds(d.date).end.getTime();
      if (since(c) >= end) return 0;
      if (dueMs !== null && dueMs <= start) return 0;
      const touched = allAnswers.some((a) => a.cardId === c.id && (isSkip(a) || isSnooze(a)) && core.etDate(new Date(a.answeredAt || a.recordedAt)) === d.date);
      return touched ? 2 : 1;
    });
    return {
      id: c.id, title: c.title, source: c.source, sourceId: c.sourceId, emoji: c.emoji, color: c.color, priority: c.priority,
      createdAt: c.createdAt, expiresAt: due, status: state, inDeck: state === 'pending',
      snoozedUntil: state === 'snoozed' ? c.snoozedUntil : undefined, live: liveIds.has(c.id),
      skips, snoozes, daysPending: Math.floor(age), overdue, dueSoon, strip,
      score: Math.round(((skips + snoozes) * 3 + age + (overdue ? 5 : dueSoon ? 2 : 0) + (c.priority === 'high' ? 2 : 0)) * 10) / 10,
      body: c.body, details: c.details,
    };
  };
  const rows = [...pendingCards.map((c) => row(c, 'pending')), ...snoozedCards.map((c) => row(c, 'snoozed')), ...overdueCards.map((c) => row(c, 'overdue'))];
  const attention = rows.slice().sort((a, b) => b.score - a.score || (a.expiresAt || '9') .localeCompare(b.expiresAt || '9') || a.id.localeCompare(b.id));

  const byBot = new Map();
  for (const c of openCards) { const k = c.source || 'Unknown'; const e = byBot.get(k) || { source: k, color: c.color, emoji: c.emoji, open: 0, snoozed: 0 }; e.open++; if (c.status === 'snoozed' && !core.isPending(c, now)) e.snoozed++; byBot.set(k, e); }
  const dueSoon = rows.filter((r) => r.overdue || r.dueSoon).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));

  // Cleared streak: a day counts as cleared if its end-of-day backup (or, for today, the live store) has no open
  // real cards. Days with no record break the streak. Today only counts once cleared; otherwise we count from yesterday.
  const backupByDate = new Map(cardBackups.map((b) => [b.date, b.cards]));
  const clearedOn = (date) => {
    if (date === today) return openCards.length === 0;
    const snap = backupByDate.get(date); if (!snap) return null;
    const end = new Date(core.etDayBounds(date).end.getTime() - 1);
    return !snap.some((c) => real(c) && c.status !== 'answered' && !(c.expiresAt && Date.parse(c.expiresAt) <= end.getTime()));
  };
  let streak = 0; let d = clearedOn(today) ? today : addDays(today, -1);
  if (clearedOn(today)) streak = 1, d = addDays(today, -1);
  for (let guard = 0; guard < 400; guard++, d = addDays(d, -1)) { if (clearedOn(d) !== true) break; streak++; }

  const oldest = openCards.length ? openCards.reduce((m, c) => (since(c) < since(m) ? c : m)) : null;
  return {
    generatedAt: now.toISOString(), today, tz: core.TZ, days,
    history: {
      start: historyStart, answerRecords: allAnswers.length, cardBackups: cardBackups.map((b) => b.date), answerBackups: answerBackups.map((b) => b.date),
      note: allAnswers.length ? null : 'No answer history yet: answers before Oct 17, 2026 were lost, and none have been recorded since except as shown.',
    },
    summary: {
      pending: pendingCards.length, snoozed: snoozedCards.length, open: openCards.length, overdue: overdueCards.length,
      dueSoon: rows.filter((r) => r.dueSoon).length,
      oldestPendingDays: oldest ? Math.floor(ageDays(oldest)) : null, oldestPendingId: oldest ? oldest.id : null, oldestPendingTitle: oldest ? oldest.title : null,
      clearedStreak: streak, skippedOrSnoozedTotal: rows.reduce((n, r) => n + r.skips + r.snoozes, 0),
    },
    attention, series, byBot: [...byBot.values()].sort((a, b) => b.open - a.open || a.source.localeCompare(b.source)), dueSoon: dueSoon.map((r) => r.id),
  };
}
module.exports = { compute, backupFiles };
