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
// Private by default: data dirs 700, data files 600 (owner only). mkdir's mode only applies to dirs it creates, so
// mkdirPrivate also tightens an existing dir; writeJsonAtomic creates the temp file 600 and rename keeps that mode.
const DIR_MODE = 0o700, FILE_MODE = 0o600;
function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { if ((fs.statSync(dir).mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE); } catch (_) { /* best effort */ }
}
function ensureDir() { mkdirPrivate(DATA_DIR); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJsonAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', FILE_MODE);
  try { fs.fchmodSync(fd, FILE_MODE); fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file); // atomic on same filesystem
}
const loadCards = () => readJson(CARDS_FILE, []);
const loadAnswers = () => readJson(ANSWERS_FILE, []);
// Daily backups: every save also writes data/backups/<kind>-YYYY-MM-DD.json (America/New_York date; the latest save of
// the day overwrites that day's file; atomic) and prunes to the newest BACKUP_KEEP_DAYS files. Backups are write-only:
// nothing ever restores from them automatically. A backup failure is logged but never fails the real save.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP_DAYS = 14;
const BACKUP_RE = (kind) => new RegExp(`^${kind}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
function listBackups(kind) { // newest first
  const re = BACKUP_RE(kind);
  try { return fs.readdirSync(BACKUP_DIR).filter((f) => re.test(f)).sort().reverse(); } catch (_) { return []; }
}
// Off-box mirror: the same daily file is also written to MIRROR_DIR (the persistent agent store, outside /workspace,
// so a workspace restore can't wipe it). On by default only for the live ./data store; set MD_BACKUP_MIRROR_DIR to
// override (empty string = off). Mirror keeps MIRROR_KEEP_DAYS files. Mode 600 is requested; a FUSE store that refuses
// chmod is tolerated (logged once). A mirror failure never fails the save or the local backup.
const LIVE_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_MIRROR = '/cursor/stores/store-32b0f9fc-e45e-41a6-b51c-6bded31ff871/morning-deck-backups';
const MIRROR_DIR = process.env.MD_BACKUP_MIRROR_DIR !== undefined ? (process.env.MD_BACKUP_MIRROR_DIR ? path.resolve(process.env.MD_BACKUP_MIRROR_DIR) : '')
  : (DATA_DIR === LIVE_DATA_DIR ? DEFAULT_MIRROR : '');
const MIRROR_KEEP_DAYS = 30;
let mirrorChmodWarned = false;
function listIn(dir, kind) { const re = BACKUP_RE(kind); try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort().reverse(); } catch (_) { return []; } }
function mirrorBackup(kind, data, now = new Date()) {
  if (!MIRROR_DIR || process.env.MD_DEMO === '1') return null;
  try {
    const file = path.join(MIRROR_DIR, `${kind}-${etDate(now)}.json`);
    if (Array.isArray(data) && data.length === 0) {
      try { const prev = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(prev) && prev.length) return null; } catch (_) {}
    }
    fs.mkdirSync(MIRROR_DIR, { recursive: true, mode: DIR_MODE });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', FILE_MODE);
    try { fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n'); try { fs.fsyncSync(fd); } catch (_) {} } finally { fs.closeSync(fd); }
    try { fs.chmodSync(tmp, FILE_MODE); } catch (e) {
      if (!mirrorChmodWarned) { mirrorChmodWarned = true; console.warn(`${new Date().toISOString()} backup mirror: chmod 600 refused by ${MIRROR_DIR} (${e.code}); the store controls access`); }
    }
    fs.renameSync(tmp, file);
    for (const old of listIn(MIRROR_DIR, kind).slice(MIRROR_KEEP_DAYS)) { try { fs.unlinkSync(path.join(MIRROR_DIR, old)); } catch (_) {} }
    return file;
  } catch (e) { console.error(`${new Date().toISOString()} backup mirror ${kind} failed: ${e.message}`); return null; }
}
// Newest backup of a kind across the local dir and the mirror: {file (absolute), name, where} or null.
function newestBackup(kind) {
  const all = [...listBackups(kind).map((n) => ({ name: n, file: path.join(BACKUP_DIR, n), where: 'local' })),
    ...(MIRROR_DIR ? listIn(MIRROR_DIR, kind).map((n) => ({ name: n, file: path.join(MIRROR_DIR, n), where: 'mirror' })) : [])];
  all.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : a.where === 'local' ? -1 : 1));
  return all[0] || null;
}
function backupDaily(kind, data, now = new Date()) {
  if (process.env.MD_DEMO === '1') return null; // the public demo re-seeds samples hourly; nothing worth keeping
  try {
    const file = path.join(BACKUP_DIR, `${kind}-${etDate(now)}.json`);
    // Safety: an empty save never replaces a same-day backup that holds data (e.g. an accidental reset after real cards).
    if (Array.isArray(data) && data.length === 0) {
      try { const prev = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(prev) && prev.length) return null; } catch (_) { /* no usable backup yet */ }
    }
    mkdirPrivate(BACKUP_DIR);
    writeJsonAtomic(file, data);
    for (const old of listBackups(kind).slice(BACKUP_KEEP_DAYS)) { try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (_) {} }
    return file;
  } catch (e) { console.error(`${new Date().toISOString()} backup ${kind} failed: ${e.message}`); return null; }
}
const saveCards = (c) => { writeJsonAtomic(CARDS_FILE, c); backupDaily('cards', c); mirrorBackup('cards', c); };
const saveAnswers = (a) => { writeJsonAtomic(ANSWERS_FILE, a); backupDaily('answers', a); mirrorBackup('answers', a); };

// Startup safety net: if cards.json has no pending (non-sample) cards but the newest cards backup does, log a loud
// warning and write data/queue-warning.json (ids + titles only). Never restores anything. The file is removed when the
// condition no longer applies.
const QUEUE_WARNING_FILE = path.join(DATA_DIR, 'queue-warning.json');
function checkQueueWarning(now = new Date()) {
  const pend = (list) => (Array.isArray(list) ? list : []).filter((c) => c && !c.sample && isPending(c, now));
  const clear = () => { try { fs.unlinkSync(QUEUE_WARNING_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  try {
    if (pend(readJson(CARDS_FILE, [])).length) { clear(); return null; }
    const nb = newestBackup('cards');
    if (!nb) { clear(); return null; }
    const newest = nb.name;
    const lost = pend(readJson(nb.file, []));
    if (!lost.length) { clear(); return null; }
    const warning = {
      at: now.toISOString(), backupFile: nb.where === 'local' ? path.join('backups', newest) : nb.file, backupLocation: nb.where, pendingInBackup: lost.length,
      cards: lost.map((c) => ({ id: c.id, title: c.title })),
      note: 'cards.json has no pending cards but this backup does. Nothing was restored automatically; review the backup and re-file cards deliberately.',
    };
    writeJsonAtomic(QUEUE_WARNING_FILE, warning);
    console.warn(`${now.toISOString()} WARNING: cards.json has no pending cards but ${newest} has ${lost.length}. See ${QUEUE_WARNING_FILE}. Nothing was restored.`);
    return warning;
  } catch (e) { console.error(`${new Date().toISOString()} queue-warning check failed: ${e.message}`); return null; }
}
// Startup: tighten modes on what already exists (chmod only; never reads or rewrites file contents).
function hardenPermissions() {
  const out = [];
  const fix = (p, mode) => { try { const st = fs.statSync(p); if ((st.mode & 0o777) !== mode) { fs.chmodSync(p, mode); out.push(p); } } catch (_) { /* missing: fine */ } };
  for (const d of [DATA_DIR, BACKUP_DIR, UPLOADS_DIR]) fix(d, DIR_MODE);
  for (const f of [CARDS_FILE, ANSWERS_FILE, BUILTIN_FILE, QUEUE_WARNING_FILE, path.join(DATA_DIR, 'push.json')]) fix(f, FILE_MODE);
  try { for (const f of fs.readdirSync(BACKUP_DIR)) if (f.endsWith('.json')) fix(path.join(BACKUP_DIR, f), FILE_MODE); } catch (_) {}
  try { for (const f of fs.readdirSync(UPLOADS_DIR)) fix(path.join(UPLOADS_DIR, f), FILE_MODE); } catch (_) {}
  return out;
}
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
  // Posting-API aliases: `question` -> title, `context` -> body (title/body win when both are sent).
  if (input && input.title === undefined && input.question !== undefined) input = { ...input, title: input.question };
  if (input && input.body === undefined && input.context !== undefined) input = { ...input, body: input.context };
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
  // Optional due date (shown on the card; due today/overdue ranks first in assemble). `due` is accepted as an alias.
  { const d = input.dueAt ?? input.due;
    if (d !== undefined && d !== null) { if (!isIso(d)) errors.push('dueAt must be an ISO-8601 date-time'); else c.dueAt = new Date(d).toISOString(); } }
  if (input.sample !== undefined && typeof input.sample !== 'boolean') errors.push('sample must be boolean');
  c.sample = input.sample === true;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((t) => !isStr(t) || t.length > 40) || input.tags.length > 10) errors.push('tags must be an array of <=10 short strings');
    else c.tags = input.tags;
  }
  if (input.replyTo !== undefined && input.replyTo !== null) {
    if (typeof input.replyTo !== 'object' || Array.isArray(input.replyTo)) errors.push('replyTo must be an object');
    else if (JSON.stringify(input.replyTo).length > 2000) errors.push('replyTo too large');
    else if (input.replyTo.agentId !== undefined && (!isStr(input.replyTo.agentId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(input.replyTo.agentId))) errors.push('replyTo.agentId must be a 1-120 char id string');
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
  if (card.withdrawn) return false; // withdrawal convention: closed by a bot, no answer
  if (!ignoreExpiry && card.expiresAt && Date.parse(card.expiresAt) <= now.getTime()) return false;
  if (card.status === 'snoozed' && card.snoozedUntil && Date.parse(card.snoozedUntil) > now.getTime()) return false;
  return true;
}

// Due bucket: 0 = overdue, 1 = due today (America/New_York), 2 = later or no due date.
function dueRank(card, now = new Date()) {
  if (!card.dueAt) return 2;
  const t = Date.parse(card.dueAt); if (!Number.isFinite(t)) return 2;
  if (t < now.getTime()) return 0;
  return t < etDayBounds(etDate(now)).end.getTime() ? 1 : 2;
}
function sortDeck(cards, now = new Date()) {
  return cards.slice().sort((a, b) => (dueRank(a, now) - dueRank(b, now)) || (dueRank(a, now) < 2 && (Date.parse(a.dueAt) - Date.parse(b.dueAt))) || (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || a.id.localeCompare(b.id));
}

module.exports = {
  ROOT, DATA_DIR, CARDS_FILE, ANSWERS_FILE, BUILTIN_FILE, UPLOADS_DIR, TZ, GESTURES, TYPES, PRIORITIES, DEFAULT_GESTURES,
  BACKUP_DIR, BACKUP_KEEP_DAYS, QUEUE_WARNING_FILE, listBackups, backupDaily, checkQueueWarning,
  MIRROR_DIR, MIRROR_KEEP_DAYS, mirrorBackup, newestBackup,
  DIR_MODE, FILE_MODE, mkdirPrivate, hardenPermissions, ensureDataDir: ensureDir,
  loadCards, loadAnswers, saveCards, saveAnswers, loadBuiltin, saveBuiltin, writeJsonAtomic, withLock,
  tzParts, zonedToUtc, nextSixAmET, etDate, etDayBounds, validateCard, effectiveGestures, isPending, sortDeck, dueRank, slug,
  FEEDBACK_RE, feedbackId, feedbackCard, builtinState,
};
