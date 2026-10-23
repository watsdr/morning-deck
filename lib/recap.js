'use strict';
// Weekly recap: computed on the fly from answers (live + backups) and lib/insights. Read-only, never a card.
//  - decisions: real answers recorded this week (Mon 00:00 ET -> now), skips/snoozes/undone excluded
//  - longestSkipped: open cards skipped/snoozed the most (then the longest pending)
//  - waitingOn: which bot is waiting on Derek the most (open cards, summed days pending)
const fs = require('fs');
const core = require('./core');
const insights = require('./insights');

function weekStart(now) {
  const p = core.tzParts(now);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); // 0 = Sun
  const back = (dow + 6) % 7;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  return core.zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0);
}
function readList(file) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; } catch (_) { return []; } }

function compute({ cards = core.loadCards(), answers = core.loadAnswers(), now = new Date(), withBackups = true } = {}) {
  const start = weekStart(now);
  const ans = new Map();
  if (withBackups) for (const b of insights.backupFiles('answers')) for (const a of readList(b.file)) if (a && a.id) ans.set(a.id, a);
  for (const a of answers) if (a && a.id) ans.set(a.id, a);
  const undoneIds = new Set([...ans.values()].filter((a) => a.gesture === 'undo' && a.undoes).map((a) => a.undoes));
  const real = [...ans.values()].filter((a) => a.gesture !== 'undo' && !a.undone && !undoneIds.has(a.id) && !a.sample && !a.builtin && !core.FEEDBACK_RE.test(a.cardId || ''));
  const at = (a) => Date.parse(a.answeredAt || a.recordedAt);
  const inWeek = real.filter((a) => at(a) >= start.getTime() && at(a) <= now.getTime());
  const isSkip = (a) => a.gesture === 'down', isSnooze = (a) => a.gesture === 'up' && !!a.snoozedUntil;
  const decisions = inWeek.filter((a) => !isSkip(a) && !isSnooze(a)).sort((a, b) => at(b) - at(a))
    .map((a) => ({ cardId: a.cardId, title: a.cardTitle, source: a.source, label: a.label, gesture: a.gesture, text: typeof a.value === 'string' && a.gesture === 'tap3' ? a.value.slice(0, 140) : undefined, at: a.answeredAt || a.recordedAt }));

  const ins = insights.compute({ cards, answers, now });
  const open = ins.attention.filter((r) => r.status === 'pending' || r.status === 'snoozed');
  const longestSkipped = open.filter((r) => r.skips + r.snoozes > 0 || r.daysPending >= 1)
    .sort((a, b) => (b.skips + b.snoozes) - (a.skips + a.snoozes) || b.daysPending - a.daysPending || a.id.localeCompare(b.id))
    .slice(0, 5).map((r) => ({ id: r.id, title: r.title, source: r.source, emoji: r.emoji, skips: r.skips, snoozes: r.snoozes, daysPending: r.daysPending }));
  const bots = new Map();
  for (const r of open) {
    const k = r.source || 'Unknown'; const e = bots.get(k) || { source: k, emoji: r.emoji, open: 0, waitingDays: 0, oldestDays: 0 };
    e.open++; e.waitingDays += r.daysPending; e.oldestDays = Math.max(e.oldestDays, r.daysPending); bots.set(k, e);
  }
  const waitingOn = [...bots.values()].sort((a, b) => b.waitingDays - a.waitingDays || b.open - a.open || a.source.localeCompare(b.source));
  return {
    generatedAt: now.toISOString(), tz: core.TZ, weekStart: start.toISOString(), weekStartDate: core.etDate(start),
    counts: { decisions: decisions.length, skips: inWeek.filter(isSkip).length, snoozes: inWeek.filter(isSnooze).length, open: open.length },
    decisions, longestSkipped, waitingOn: waitingOn.slice(0, 5), topWaiting: waitingOn[0] || null,
  };
}
module.exports = { compute, weekStart };
