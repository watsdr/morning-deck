'use strict';
// "Skipped & snoozed": which open cards keep getting skipped (down) or snoozed (up), how long each has waited, and
// which bots have the most open items. Built only from data/cards.json + data/answers.json (no samples, no guesses).
// Answer history before Oct 17, 2026 was lost, so counts start at the first recorded answer; the payload says so.
const core = require('./core');
const DAY = 86400e3;
function build(cards, answers, now = new Date()) {
  const t = now.getTime();
  const real = (Array.isArray(cards) ? cards : []).filter((c) => c && !c.sample && !c.builtin);
  const live = (Array.isArray(answers) ? answers : []).filter((a) => a && !a.sample && !a.undone && a.gesture !== 'undo');
  const counts = new Map();
  for (const a of live) {
    if (a.gesture !== 'down' && a.gesture !== 'up') continue;
    const r = counts.get(a.cardId) || { skips: 0, snoozes: 0, last: null };
    if (a.gesture === 'down') r.skips++; else r.snoozes++;
    const at = a.answeredAt || a.recordedAt; if (at && (!r.last || at > r.last)) r.last = at;
    counts.set(a.cardId, r);
  }
  const snoozedNow = (c) => c.status === 'snoozed' && c.snoozedUntil && Date.parse(c.snoozedUntil) > t && !c.withdrawn && !(core.expiryOf(c) <= t);
  const open = real.filter((c) => core.isPending(c, now) || snoozedNow(c));
  const since = (c) => { const v = [c.createdAt, c.receivedAt].map(Date.parse).filter(Number.isFinite); return v.length ? Math.min(...v) : t; };
  const rows = open.map((c) => {
    const k = counts.get(c.id) || { skips: 0, snoozes: 0, last: null };
    return { id: c.id, title: c.title, emoji: c.emoji || '', source: c.source, skips: k.skips, snoozes: k.snoozes, lastPassed: k.last,
      daysWaiting: Math.max(0, Math.floor((t - since(c)) / DAY)), snoozedUntil: snoozedNow(c) ? c.snoozedUntil : null };
  });
  const passed = rows.filter((r) => r.skips || r.snoozes).sort((a, b) => (b.skips + b.snoozes) - (a.skips + a.snoozes) || b.daysWaiting - a.daysWaiting);
  const waiting = rows.filter((r) => !r.skips && !r.snoozes).sort((a, b) => b.daysWaiting - a.daysWaiting);
  const bots = new Map();
  for (const r of rows) {
    const b = bots.get(r.source) || { source: r.source, emoji: r.emoji, open: 0, passed: 0, oldestDays: 0 };
    b.open++; if (r.skips || r.snoozes) b.passed++; b.oldestDays = Math.max(b.oldestDays, r.daysWaiting); bots.set(r.source, b);
  }
  const firstAnswer = live.map((a) => a.answeredAt || a.recordedAt).filter(Boolean).sort()[0] || null;
  return {
    generatedAt: now.toISOString(), passed, waiting, bots: [...bots.values()].sort((a, b) => b.open - a.open || b.oldestDays - a.oldestDays),
    totals: { open: rows.length, skipsRecorded: [...counts.values()].reduce((n, r) => n + r.skips, 0), snoozesRecorded: [...counts.values()].reduce((n, r) => n + r.snoozes, 0) },
    history: { firstAnswer, answers: live.length, note: 'Answers before the Oct 17, 2026 data loss are gone, so skip and snooze counts only cover what was recorded after it.' },
  };
}
module.exports = { build };
