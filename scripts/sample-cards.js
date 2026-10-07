// Sample (clearly fake) cards for demos. Every card has sample:true and a body that says it's an example.
// createdAt is spread across "this morning" so the deck looks realistic.
module.exports = function sampleCards(now = new Date()) {
  const ago = (m) => new Date(now.getTime() - m * 60000).toISOString();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now); // YYYY-MM-DD
  return [
    {
      id: `scheduler-move-1on1-${day}`, source: 'Scheduler', sourceId: 'bot-scheduler', emoji: '📅', color: '#6d7cff',
      type: 'question', priority: 'high', sample: true, createdAt: ago(95),
      title: 'Move Thursday’s 1:1 to 3:30 PM?',
      body: 'Example card: a made-up conflict between a 2:00 PM 1:1 and a dentist slot. Swipe right to accept the new time, left to keep it as is.',
      details: 'EXAMPLE DATA, not a real calendar.\n\nCurrent: Thu 2:00–2:30 PM · 1:1 (sample)\nProposed: Thu 3:30–4:00 PM\nConflict: Dentist 1:45 PM (sample)\n\nIf you say yes, the Scheduler bot would propose the new time later. Nothing is sent from Morning Deck.',
      gestures: { right: { label: 'Move it', value: 'yes' }, left: { label: 'Keep 2 PM', value: 'no' } },
      replyTo: { bot: 'scheduler', task: 'sample-task-1' },
    },
    {
      id: `work-vendor-summary-${day}`, source: 'Work', sourceId: 'bot-work', emoji: '🏢', color: '#14a3d9',
      type: 'question', priority: 'high', sample: true, createdAt: ago(80),
      title: 'Share the vendor summary draft with the team?',
      body: 'Example card: a fictional weekly vendor summary is drafted and waiting. Approving only records “yes”; the bot would share it later.',
      details: 'EXAMPLE DATA.\n\nDraft: “Weekly vendor summary (sample)”\n• 3 open POs (fictional)\n• 1 late shipment (fictional)\n\nTriple-tap reply example: “Add the shipping ETA first.”',
      gestures: { right: { label: 'Approve', value: 'approve' }, left: { label: 'Hold', value: 'hold' }, down: { label: 'Not mine', value: 'not_mine' } },
      replyTo: { bot: 'work', thread: 'sample-thread' },
    },
    {
      id: `finance-extra-500-${day}`, source: 'Finance', sourceId: 'bot-finance', emoji: '💰', color: '#12b886',
      type: 'choice', priority: 'normal', sample: true, createdAt: ago(70),
      title: 'Where should an extra $500 go this month?',
      body: 'Example card with made-up numbers. Pick a direction for the option you prefer.',
      details: 'EXAMPLE DATA, not financial advice and not your real accounts.\n\n• Index fund: long-term growth\n• Pay card: clears a fictional 22% APR balance\n• Emergency fund: tops up to a sample 4-month cushion',
      gestures: {
        right: { label: 'Index fund', value: 'index_fund' },
        left: { label: 'Pay card', value: 'pay_card' },
        down: { label: 'Emergency fund', value: 'emergency_fund' },
        up: { label: 'Later', value: 'snooze' },
      },
    },
    {
      id: `side-project-newsletter-name-${day}`, source: 'Side Project', sourceId: 'bot-side-project', emoji: '🚀', color: '#ff9f1c',
      type: 'choice', priority: 'normal', sample: true, createdAt: ago(55),
      title: 'Pick a name for the newsletter test',
      body: 'Example card: two placeholder names for a pretend landing-page test.',
      gestures: {
        right: { label: 'Morning Signal', value: 'morning_signal' },
        left: { label: 'Quiet Compound', value: 'quiet_compound' },
        down: { label: 'Neither', value: 'neither' },
        tap3: { label: 'Suggest', prompt: 'Suggest a different name' },
      },
    },
    {
      id: `health-sleep-weekly-${day}`, source: 'Health', sourceId: 'bot-health', emoji: '🫀', color: '#f0567a',
      type: 'info', priority: 'low', sample: true, createdAt: ago(40),
      title: 'Sleep averaged 6h 40m this week',
      body: 'Example FYI with invented numbers: 25 minutes under your sample goal; lights-out drifted later on weeknights.',
      details: 'EXAMPLE DATA, not from a real tracker.\n\nMon 6:55 · Tue 6:20 · Wed 6:45 · Thu 6:30 · Fri 7:10\nSuggestion (sample): aim for lights-out by 10:45 PM.',
      gestures: { right: { label: 'Got it', value: 'ack' } },
    },
  ];
};
