'use strict';
// Morning Deck core: storage (atomic JSON files), validation, gesture defaults, time helpers.
// SAFETY: nothing in here talks to the network. Answers are only recorded to disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
// MD_DATA_DIR (or DATA_DIR) points a test server at a scratch store; default is ./data.
const DATA_DIR = path.resolve(process.env.MD_DATA_DIR || process.env.DATA_DIR || path.join(ROOT, 'data'));
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const ANSWERS_FILE = path.join(DATA_DIR, 'answers.json');
const BUILTIN_FILE = path.join(DATA_DIR, 'builtin.json'); // state (answered/snoozed) of built-in cards
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TZ = 'America/New_York';

const GESTURES = ['right', 'left', 'up', 'down', 'tap3'];
const TYPES = ['question', 'choice', 'info'];
const PRIORITIES = ['high', 'normal', 'low'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

const DEFAULT_GESTURES = {
  question: {
    right: { label: 'Yes', value: 'yes' },
    left: { label: 'No', value: 'no' },
    up: { label: 'Later', value: 'snooze', snooze: true },
    down: { label: 'Skip', value: 'skip' },
    tap3: { label: 'Reply', value: 'reply', prompt: 'Type a custom reply' },
  },
  choice: {
    right: { label: 'Approve', value: 'approve' },
    left: { label: 'Decline', value: 'decline' },
    up: { label: 'Later', value: 'snooze', snooze: true },
    down: { label: 'Skip', value: 'skip' },
    tap3: { label: 'Reply', value: 'reply', prompt: 'Type a custom reply' },
  },
  info: {
    right: { label: 'Got it', value: 'ack' },
    left: { label: 'Not useful', value: 'not_useful' },
    up: { label: 'Later', value: 'snooze', snooze: true },
    down: { label: 'Not mine', value: 'not_mine' },
    tap3: { label: 'Reply', value: 'reply', prompt: 'Add a note for the bot' },
  },
};

// ---------- file IO ----------
function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJsonAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file); // atomic on same filesystem
}
const loadCards = () => readJson(CARDS_FILE, []);
const loadAnswers = () => readJson(ANSWERS_FILE, []);
const saveCards = (c) => writeJsonAtomic(CARDS_FILE, c);
const saveAnswers = (a) => writeJsonAtomic(ANSWERS_FILE, a);
const loadBuiltin = () => readJson(BUILTIN_FILE, []);
const saveBuiltin = (a) => writeJsonAtomic(BUILTIN_FILE, a);

// Serialize all mutations in-process so concurrent requests can't interleave read-modify-write.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- time ----------
function tzParts(date, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}
// Convert a wall-clock time in TZ to a UTC Date (handles DST by iterating).
function zonedToUtc(y, m, d, h, mi = 0, tz = TZ) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    const diff = asUtc - Date.UTC(y, m - 1, d, h, mi);
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}
// Next 6:00 AM America/New_York strictly after `now`.
function nextSixAmET(now = new Date()) {
  const p = tzParts(now);
  let target = zonedToUtc(p.y, p.m, p.d, 6, 0);
  if (target <= now) {
    const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    target = zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 6, 0);
  }
  return target;
}

// YYYY-MM-DD in America/New_York
function etDate(now = new Date()) { const p = tzParts(now); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
function etDayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { start: zonedToUtc(y, m, d, 0, 0), end: zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0) };
}

// ---------- built-in cards ----------
// The daily "How could Morning Deck be better?" card. Generated here (bots never post it), always dealt last,
// one per ET day. Its answered/snoozed state lives in builtin.json so cards.json only ever holds bot cards.
const FEEDBACK_RE = /^morningdeck-feedback-(\d{4}-\d{2}-\d{2})$/;
const feedbackId = (dateStr) => `morningdeck-feedback-${dateStr}`;
function feedbackCard(dateStr) {
  const { start, end } = etDayBounds(dateStr);
  return {
    id: feedbackId(dateStr), source: 'Morning Deck', sourceId: 'morning-deck', emoji: '🌅', color: '#ff7a59',
    type: 'question', priority: 'low', builtin: true, sample: false,
    title: 'How could Morning Deck be better?',
    body: 'That’s the deck for today. Got an idea, a bug, or a wish? Anything that would make your mornings smoother counts, and a screenshot helps.',
    createdAt: start.toISOString(), expiresAt: end.toISOString(),
    gestures: {
      right: { label: 'Love it', value: 'love_it' },
      left: { label: "Something's off", value: 'something_off', reply: true, prompt: 'What’s off? Tell me what to fix' },
      down: { label: 'Skip', value: 'skip' },
      up: { label: 'Later', value: 'snooze', snooze: true },
      tap3: { label: 'Suggest', value: 'suggestion', prompt: 'Your idea, bug, or wish' },
    },
    replyTo: { bot: 'morning-deck' }, tags: ['feedback', 'built-in'],
  };
}
const BUILTIN_STATE_KEYS = ['id', 'status', 'answeredAt', 'snoozedUntil', 'snoozeCount', 'lastAnswerId'];
function builtinState(card) {
  const o = {}; for (const k of BUILTIN_STATE_KEYS) if (card[k] !== undefined) o[k] = card[k];
  o.updatedAt = new Date().toISOString();
  return o;
}

// ---------- validation ----------
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isStr = (v) => typeof v === 'string';
const isIso = (v) => isStr(v) && !Number.isNaN(Date.parse(v));
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot';
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function validateCard(input, now = new Date()) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['card must be an object'] };
  const c = {};
  const req = (k, max) => {
    if (!isStr(input[k]) || !input[k].trim()) errors.push(`${k} is required (non-empty string)`);
    else if (input[k].length > max) errors.push(`${k} must be <= ${max} chars`);
    else c[k] = input[k].trim();
  };
  const opt = (k, max) => {
    if (input[k] === undefined || input[k] === null || input[k] === '') return;
    if (!isStr(input[k])) errors.push(`${k} must be a string`);
    else if (input[k].length > max) errors.push(`${k} must be <= ${max} chars`);
    else c[k] = input[k];
  };
  req('source', 60);
  req('title', 200);
  opt('body', 4000);
  opt('details', 20000);
  opt('sourceId', 120);
  opt('emoji', 16);
  if (input.color !== undefined && input.color !== null) {
    if (!isStr(input.color) || !COLOR_RE.test(input.color)) errors.push('color must be #RGB or #RRGGBB');
    else c.color = input.color;
  }
  if (input.id !== undefined) {
    if (!isStr(input.id) || !ID_RE.test(input.id)) errors.push('id must match ' + ID_RE);
    else c.id = input.id;
  }
  c.type = input.type === undefined ? 'question' : input.type;
  if (!TYPES.includes(c.type)) errors.push(`type must be one of ${TYPES.join('|')}`);
  c.priority = input.priority === undefined ? 'normal' : input.priority;
  if (!PRIORITIES.includes(c.priority)) errors.push(`priority must be one of ${PRIORITIES.join('|')}`);
  if (input.createdAt !== undefined) {
    if (!isIso(input.createdAt)) errors.push('createdAt must be an ISO-8601 date-time');
    else c.createdAt = new Date(input.createdAt).toISOString();
  } else c.createdAt = now.toISOString();
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (!isIso(input.expiresAt)) errors.push('expiresAt must be an ISO-8601 date-time');
    else c.expiresAt = new Date(input.expiresAt).toISOString();
  }
  if (input.sample !== undefined && typeof input.sample !== 'boolean') errors.push('sample must be boolean');
  c.sample = input.sample === true;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((t) => !isStr(t) || t.length > 40) || input.tags.length > 10) errors.push('tags must be an array of <=10 short strings');
    else c.tags = input.tags;
  }
  if (input.replyTo !== undefined && input.replyTo !== null) {
    if (typeof input.replyTo !== 'object' || Array.isArray(input.replyTo)) errors.push('replyTo must be an object');
    else if (JSON.stringify(input.replyTo).length > 2000) errors.push('replyTo too large');
    else c.replyTo = input.replyTo;
  }
  if (input.gestures !== undefined && input.gestures !== null) {
    const g = input.gestures;
    if (typeof g !== 'object' || Array.isArray(g)) errors.push('gestures must be an object');
    else {
      c.gestures = {};
      for (const [k, v] of Object.entries(g)) {
        if (!GESTURES.includes(k)) { errors.push(`gestures.${k}: unknown gesture (use ${GESTURES.join('|')})`); continue; }
        if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`gestures.${k} must be an object`); continue; }
        const out = {};
        if (v.label !== undefined) { if (!isStr(v.label) || !v.label.trim() || v.label.length > 24) errors.push(`gestures.${k}.label must be a 1-24 char string`); else out.label = v.label.trim(); }
        if (v.value !== undefined) { if (!isScalar(v.value) || (isStr(v.value) && v.value.length > 200)) errors.push(`gestures.${k}.value must be a string/number/boolean/null`); else out.value = v.value; }
        if (v.prompt !== undefined) { if (!isStr(v.prompt) || v.prompt.length > 200) errors.push(`gestures.${k}.prompt must be a string <= 200`); else out.prompt = v.prompt; }
        if (v.snooze !== undefined) { if (typeof v.snooze !== 'boolean') errors.push(`gestures.${k}.snooze must be boolean`); else out.snooze = v.snooze; }
        if (v.disabled !== undefined) { if (typeof v.disabled !== 'boolean') errors.push(`gestures.${k}.disabled must be boolean`); else out.disabled = v.disabled; }
        c.gestures[k] = out;
      }
    }
  }
  if (!c.id && !errors.length) c.id = `${slug(c.source)}-${crypto.randomBytes(5).toString('hex')}`;
  return { errors, card: c };
}

// Effective gesture map = type defaults merged with the card's overrides.
function effectiveGestures(card) {
  const base = DEFAULT_GESTURES[card.type] || DEFAULT_GESTURES.question;
  const out = {};
  for (const g of GESTURES) {
    const o = (card.gestures && card.gestures[g]) || {};
    const m = { ...base[g], ...o };
    if (o.value !== undefined && o.snooze === undefined) m.snooze = g === 'up' && o.value === 'snooze';
    if (o.value === undefined && o.label !== undefined && g !== 'tap3' && g !== 'up') m.value = slug(o.label).replace(/-/g, '_');
    out[g] = m;
  }
  return out;
}

function isPending(card, now = new Date(), { ignoreExpiry = false } = {}) {
  if (card.status === 'answered') return false;
  if (!ignoreExpiry && card.expiresAt && Date.parse(card.expiresAt) <= now.getTime()) return false;
  if (card.status === 'snoozed' && card.snoozedUntil && Date.parse(card.snoozedUntil) > now.getTime()) return false;
  return true;
}

function sortDeck(cards) {
  return cards.slice().sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || a.id.localeCompare(b.id));
}

module.exports = {
  ROOT, DATA_DIR, CARDS_FILE, ANSWERS_FILE, BUILTIN_FILE, UPLOADS_DIR, TZ, GESTURES, TYPES, PRIORITIES, DEFAULT_GESTURES,
  loadCards, loadAnswers, saveCards, saveAnswers, loadBuiltin, saveBuiltin, writeJsonAtomic, withLock,
  tzParts, zonedToUtc, nextSixAmET, etDate, etDayBounds, validateCard, effectiveGestures, isPending, sortDeck, slug,
  FEEDBACK_RE, feedbackId, feedbackCard, builtinState,
};
