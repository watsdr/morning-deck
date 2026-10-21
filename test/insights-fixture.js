// Clearly FAKE data for Insights tests/screenshots. Writes only into an isolated MD_DATA_DIR (refuses the live data/).
const fs = require('fs'); const os = require('os'); const path = require('path');
module.exports = function seedFake(dataDir, now = new Date()) {
  if (!dataDir || !path.resolve(dataDir).startsWith(os.tmpdir())) throw new Error('fixture refuses a non-temp data dir');
  const D = 864e5, iso = (ms) => new Date(ms).toISOString(), t = now.getTime();
  const card = (id, source, emoji, color, title, ageDays, extra = {}) => ({ id, source, sourceId: 'fake-' + source.toLowerCase().replace(/\W+/g, '-'), emoji, color, type: 'question', priority: 'normal', title, body: 'FAKE test card for Insights screenshots.', createdAt: iso(t - ageDays * D), sample: false, status: 'pending', receivedAt: iso(t - ageDays * D), ...extra });
  const cards = [
    card('fake-gutters-1', 'Fake Home Bot', '🏠', '#ff8a4c', 'FAKE: Book the gutter cleaning?', 9, { snoozeCount: 4 }),
    card('fake-renew-2', 'Fake Money Bot', '💸', '#19c37d', 'FAKE: Renew the imaginary magazine?', 6, { expiresAt: iso(t + 20 * 3600e3), snoozeCount: 2 }),
    card('fake-dentist-3', 'Fake Scheduler', '📅', '#6d7cff', 'FAKE: Pick a dentist slot for Zork', 4, { expiresAt: iso(t + 40 * 3600e3) }),
    card('fake-wifi-4', 'Fake Home Bot', '🏠', '#ff8a4c', 'FAKE: Rename the Wi-Fi to "Narnia"?', 2),
    card('fake-trip-5', 'Fake Trip Bot', '✈️', '#38b6ff', 'FAKE: Approve the moon hotel checkout', 5, { expiresAt: iso(t - 10 * 3600e3) }),
    card('fake-news-6', 'Fake Money Bot', '💸', '#19c37d', 'FAKE: Read the pretend budget digest', 1, { type: 'info' }),
    card('fake-done-7', 'Fake Scheduler', '📅', '#6d7cff', 'FAKE: Already answered card', 3, { status: 'answered', answeredAt: iso(t - 2 * D) }),
  ];
  const answers = [];
  const ans = (cardId, gesture, agoDays, extra = {}) => answers.push({ id: 'ans_fake' + answers.length.toString(16).padStart(4, '0'), cardId, source: cards.find((c) => c.id === cardId).source, cardTitle: 'FAKE', gesture, label: gesture, value: gesture, answeredAt: iso(t - agoDays * D), recordedAt: iso(t - agoDays * D), ...extra });
  for (const d of [8, 6, 4, 2]) ans('fake-gutters-1', 'up', d, { snoozedUntil: iso(t - (d - 1) * D) });
  for (const d of [5, 1]) ans('fake-renew-2', 'up', d, { snoozedUntil: iso(t - (d - 0.5) * D) });
  ans('fake-dentist-3', 'down', 3); ans('fake-dentist-3', 'down', 1); // skipped twice (re-filed by the fake bot)
  ans('fake-done-7', 'right', 2);
  for (const d of [7, 5, 3, 2]) ans('fake-done-7', 'down', d + 0.01, { undone: true }); // undone answers must not count
  const backups = path.join(dataDir, 'backups'); fs.mkdirSync(backups, { recursive: true });
  const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
  for (let d = 10; d >= 1; d--) {
    const snap = cards.filter((c) => Date.parse(c.createdAt) <= t - d * D + D / 2).map((c) => (c.id === 'fake-done-7' && d > 2 ? { ...c, status: 'pending', answeredAt: undefined } : c));
    fs.writeFileSync(path.join(backups, `cards-${etDate(t - d * D)}.json`), JSON.stringify(snap));
  }
  fs.writeFileSync(path.join(dataDir, 'cards.json'), JSON.stringify(cards, null, 2));
  fs.writeFileSync(path.join(dataDir, 'answers.json'), JSON.stringify(answers, null, 2));
  return { cards, answers };
};
