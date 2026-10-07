#!/usr/bin/env node
// Reset the demo: remove sample cards + their answers, re-seed fresh sample cards (pending).
// Real (non-sample) cards and their answers are left alone.
//   node scripts/reset.js          -> fresh sample deck, real data untouched
//   node scripts/reset.js --all    -> wipe EVERYTHING (all cards + whole answer log), then seed samples
//   node scripts/reset.js --empty  -> wipe everything, no samples
const core = require('../lib/core');
const sampleCards = require('./sample-cards');
const all = process.argv.includes('--all') || process.argv.includes('--empty');
const noSamples = process.argv.includes('--empty');
let cards = all ? [] : core.loadCards().filter((c) => !c.sample);
let answers = all ? [] : core.loadAnswers().filter((a) => !a.sample);
const now = new Date();
if (!noSamples) {
  for (const raw of sampleCards(now)) {
    const { errors, card } = core.validateCard(raw, now);
    if (errors.length) { console.error('invalid sample', raw.id, errors); process.exit(1); }
    cards = cards.filter((c) => c.id !== card.id);
    cards.push({ ...card, status: 'pending', receivedAt: now.toISOString() });
  }
}
core.saveCards(cards);
core.saveAnswers(answers);
console.log(`reset: ${cards.length} cards (${cards.filter((c) => c.sample).length} sample), ${answers.length} answers kept`);
