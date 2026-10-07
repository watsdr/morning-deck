/* Morning Deck for Friends — the local engine.
 * Runs entirely in this browser: settings, tokens, cards and answers live in localStorage/IndexedDB on this phone.
 * app.js (the shared swipe UI) talks to /api/*; window.MD_API_FETCH answers those calls here, with no server.
 * SAFETY: a swipe only records the decision locally, unless the friend turned on "Let swipes act" for that service,
 * and then only simple reversible actions run (complete a task, mark read/archive, RSVP), each with Undo.
 * Nothing here sends messages, deletes, or buys anything. */
(() => {
  'use strict';
  const CFG = window.MD_FRIENDS_CONFIG || {};
  const TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  window.MD_TZ = TZ;

  // ---------- storage ----------
  const P = 'mdf.v1.';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(P + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { localStorage.setItem(P + k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem(P + k); },
  };
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('mdf', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('photos', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
    }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('photos', mode); const req = fn(t.objectStore('photos')); t.oncomplete = () => res(req && req.result); t.onerror = t.onabort = () => rej(t.error); }); };
    return {
      put: (v) => tx('readwrite', (s) => s.put(v)), get: (k) => tx('readonly', (s) => s.get(k)), all: () => tx('readonly', (s) => s.getAll()).catch(() => []),
      wipe: () => new Promise((res) => { if (dbp) dbp.then((db) => db.close()).catch(() => {}); dbp = null; const r = indexedDB.deleteDatabase('mdf'); r.onsuccess = r.onerror = r.onblocked = () => res(); }),
    };
  })();

  // ---------- helpers ----------
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  function relIn(d, now = new Date()) {
    const m = Math.round((d - now) / 60000);
    if (m < -1) return `${-m < 60 ? -m + ' min' : Math.round(-m / 60) + ' h'} ago`;
    if (m <= 1) return 'now';
    return m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim() : `in ${Math.round(m / 1440)} d`;
  }
  const strip = (html) => { const d = document.createElement('div'); d.innerHTML = String(html || ''); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadScript = (src) => new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === new URL(src, location.href).href && s.dataset.loaded)) return res();
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = () => { s.dataset.loaded = '1'; res(); }; s.onerror = () => rej(new Error(`couldn't load ${new URL(src, location.href).host}`));
    document.head.appendChild(s);
  });
  class FriendlyError extends Error { constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); } }
  // fetch with timeout + friendly errors (CORS/network failures surface as TypeError in browsers)
  async function http(url, opts = {}) {
    const { timeout = 12000, json = true, service = new URL(url).host, ...rest } = opts;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    let res;
    try { res = await fetch(url, { ...rest, signal: ctl.signal }); }
    catch (e) {
      throw new FriendlyError(e.name === 'AbortError' ? `${service} took too long to answer` : `Couldn't reach ${service}. You may be offline, or ${service} doesn't let browser apps read this.`, { network: true, cors: e.name !== 'AbortError' });
    } finally { clearTimeout(t); }
    if (res.status === 401 || res.status === 403) {
      let detail = ''; try { const b = await res.clone().json(); detail = b.message || b.error_description || (b.error && (b.error.message || b.error)) || ''; } catch {}
      throw new FriendlyError(`${service} said ${res.status === 401 ? 'the token or sign-in is not valid' : 'access is not allowed'}${detail ? ` (${clip(String(detail), 120)})` : ''}`, { status: res.status, auth: true });
    }
    if (!res.ok) throw new FriendlyError(`${service} answered ${res.status}`, { status: res.status });
    if (!json) return res;
    if (res.status === 204) return null;
    return res.json();
  }

  // ---------- settings ----------
  const PRESETS = {
    yesno: { name: 'Yes / No', right: 'Yes', left: 'No' },
    donenot: { name: 'Done / Not now', right: 'Done', left: 'Not now' },
    keepdismiss: { name: 'Keep / Dismiss', right: 'Keep', left: 'Dismiss' },
  };
  const defaults = () => ({ version: 1, setupDone: false, name: '', deckTime: '07:00', gestures: { preset: 'yesno', right: 'Yes', left: 'No' }, services: {}, manual: [], createdAt: new Date().toISOString() });
  const settings = () => Object.assign(defaults(), ls.get('settings', {}));
  const saveSettings = (s) => { ls.set('settings', s); emit('mdf:settings', s); };
  const svcState = (id) => settings().services[id];
  function updateService(id, patch) { const s = settings(); s.services[id] = Object.assign({ on: true, cfg: {}, act: false }, s.services[id] || {}, patch); saveSettings(s); return s.services[id]; }
  function removeService(id) { const s = settings(); delete s.services[id]; saveSettings(s); const c = ls.get('cache', {}); delete c[id]; ls.set('cache', c); }
  const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} };

  // ---------- day logic: the deck day starts at the friend's deck time ----------
  const deckMinutes = () => { const [h, m] = (settings().deckTime || '07:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const deckDay = (now = new Date()) => ymd(new Date(now.getTime() - deckMinutes() * 60000));
  function nextDeckAt(now = new Date()) { const t = startOfDay(now); t.setMinutes(deckMinutes()); return t > now ? t : addDays(t, 1); }

  // ---------- gestures (same defaults as the server: lib/core.js) ----------
  const GESTURES = ['right', 'left', 'up', 'down', 'tap3'];
  const DEFAULT_GESTURES = {
    question: { right: { label: 'Yes', value: 'yes' }, left: { label: 'No', value: 'no' }, up: { label: 'Later', value: 'snooze', snooze: true }, down: { label: 'Skip', value: 'skip' }, tap3: { label: 'Reply', value: 'reply', prompt: 'Type a note (kept on this phone)' } },
    choice: { right: { label: 'Approve', value: 'approve' }, left: { label: 'Decline', value: 'decline' }, up: { label: 'Later', value: 'snooze', snooze: true }, down: { label: 'Skip', value: 'skip' }, tap3: { label: 'Reply', value: 'reply', prompt: 'Type a note (kept on this phone)' } },
    info: { right: { label: 'Got it', value: 'ack' }, left: { label: 'Not useful', value: 'not_useful' }, up: { label: 'Later', value: 'snooze', snooze: true }, down: { label: 'Skip', value: 'skip' }, tap3: { label: 'Note', value: 'reply', prompt: 'Add a note (kept on this phone)' } },
  };
  const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';
  function effectiveGestures(card) {
    const base = JSON.parse(JSON.stringify(DEFAULT_GESTURES[card.type] || DEFAULT_GESTURES.question));
    if (card.generic) { const g = settings().gestures || {}; if (g.right) base.right = { label: g.right, value: slug(g.right) }; if (g.left) base.left = { label: g.left, value: slug(g.left) }; }
    const out = {};
    for (const k of GESTURES) {
      const o = (card.gestures && card.gestures[k]) || {};
      const m = { ...base[k], ...o };
      if (o.label !== undefined && o.value === undefined && k !== 'tap3' && k !== 'up') m.value = slug(o.label);
      out[k] = m;
    }
    return out;
  }
  const PRIO = { high: 0, normal: 1, low: 2 };
  function normalize(c, svcId) {
    const card = { type: 'question', priority: 'normal', createdAt: new Date().toISOString(), urgency: 50, ...c };
    card.service = card.service || svcId;
    card.gestures = effectiveGestures(card);
    return card;
  }
  const sortCards = (cards) => cards.slice().sort((a, b) => (PRIO[a.priority] - PRIO[b.priority]) || ((a.urgency ?? 50) - (b.urgency ?? 50)) || (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || String(a.id).localeCompare(String(b.id)));

  // ---------- the improvement card (always last, stored locally) ----------
  function feedbackCard(day) {
    const who = CFG.ownerName ? CFG.ownerName : 'the person who shared this app';
    return {
      id: `morningdeck-feedback-${day}`, source: 'Morning Deck', emoji: '🌅', color: '#ff7a59', type: 'question', priority: 'low', builtin: true, sample: false,
      title: 'How could Morning Deck be better?',
      body: `That’s the deck for today. Got an idea, a bug, or a wish? It’s saved on this phone, and you can choose to share it with ${who}.`,
      createdAt: new Date().toISOString(), service: 'morning-deck',
      gestures: {
        right: { label: 'Love it', value: 'love_it' },
        left: { label: "Something's off", value: 'something_off', reply: true, prompt: 'What’s off? Tell us what to fix' },
        down: { label: 'Skip', value: 'skip' },
        up: { label: 'Later', value: 'snooze', snooze: true },
        tap3: { label: 'Suggest', value: 'suggestion', prompt: 'Your idea, bug, or wish' },
      },
    };
  }

  // ---------- sample deck (first open, before "Make it mine") ----------
  function sampleDeck(now = new Date()) {
    const ago = (m) => new Date(now - m * 60000).toISOString();
    const day = ymd(now);
    const s = (c) => ({ sample: true, ...c });
    return [
      s({ id: `sample-weather-${day}`, service: 'weather', source: 'Weather', emoji: '🌦️', color: '#38b6ff', type: 'info', priority: 'high', urgency: 8, chip: 'Weather', createdAt: ago(20),
        title: 'Umbrella today: rain likely 2–5 PM', body: 'Example card: up to 80% chance of rain this afternoon, 14–19°. Connect Weather and this shows your own city.',
        details: 'EXAMPLE DATA\n\n9 AM  15°  10% rain\n12 PM  17°  30% rain\n3 PM  16°  80% rain\n6 PM  14°  40% rain', gestures: { right: { label: 'Thanks', value: 'ack' } } }),
      s({ id: `sample-rsvp-${day}`, service: 'gcal', source: 'Calendar', emoji: '📅', color: '#4f7cff', type: 'question', priority: 'normal', urgency: 15, chip: 'RSVP needed', createdAt: ago(55),
        title: 'RSVP: Design review, Thu 3:00 PM', body: 'Example card: you haven’t answered this invite yet. With “Let swipes act” on, Accept/Decline sends your RSVP (no message is sent).',
        details: 'EXAMPLE DATA\n\nThu 3:00–3:45 PM · Room 4 (sample)\nOrganizer: a teammate (sample)', gestures: { right: { label: 'Accept', value: 'accept' }, left: { label: 'Decline', value: 'decline' } } }),
      s({ id: `sample-task-${day}`, service: 'todoist', source: 'Todoist', emoji: '✅', color: '#e44332', type: 'question', priority: 'high', urgency: 10, chip: 'Overdue', createdAt: ago(300),
        title: 'Renew passport', body: 'Example card: 2 days overdue · Personal. Swipe right to mark it done.', gestures: { right: { label: 'Done', value: 'done' }, left: { label: 'Not today', value: 'not_today' } } }),
      s({ id: `sample-mail-${day}`, service: 'gmail', source: 'Email', emoji: '✉️', color: '#ea4335', type: 'question', priority: 'normal', urgency: 30, chip: 'Important · unread', createdAt: ago(40),
        title: 'Your flight check-in is open', body: 'Example card: From an airline (sample) · Check in now to choose your seat…', gestures: { right: { label: 'Archive', value: 'archive' }, left: { label: 'Mark read', value: 'mark_read' } } }),
      s({ id: `sample-conflict-${day}`, service: 'ics', source: 'Calendar', emoji: '⚠️', color: '#ff8a3d', type: 'info', priority: 'high', urgency: 5, chip: 'Conflict', createdAt: ago(60),
        title: 'Two things at 12:30 today', body: 'Example card: “Lunch with Sam” overlaps “Dentist” (12:30–1:15). Something has to move.', gestures: { right: { label: 'Got it', value: 'ack' } } }),
      s({ id: `sample-github-${day}`, service: 'github', source: 'GitHub', emoji: '🐙', color: '#6e5494', type: 'question', priority: 'normal', urgency: 20, chip: 'Review requested', createdAt: ago(130),
        title: 'Review requested: Fix typo in README (#42)', body: 'Example card: example/project · opened by a contributor (sample).', gestures: { right: { label: 'On it', value: 'on_it' }, left: { label: 'Not now', value: 'not_now' } } }),
      s({ id: `sample-inbox-${day}`, service: 'inbox', source: 'Home Assistant', emoji: '🏠', color: '#18bcf2', type: 'info', priority: 'normal', urgency: 40, chip: 'Universal inbox', createdAt: ago(15),
        title: 'Washing machine finished', body: 'Example card: anything that can send a web request (Zapier, IFTTT, Make, Shortcuts, Home Assistant) can drop cards here.' }),
      s({ id: `sample-news-${day}`, service: 'news', source: 'News', emoji: '📰', color: '#7c6cf2', type: 'info', priority: 'low', urgency: 60, chip: 'Headline', createdAt: ago(90),
        title: 'City opens three new bike lanes downtown', body: 'Example card: a made-up headline. Connect News and pick your own feeds.', gestures: { right: { label: 'Interesting', value: 'interesting' }, left: { label: 'Not for me', value: 'not_for_me' } } }),
      s({ id: `sample-manual-${day}`, service: 'manual', source: 'Reminder', emoji: '🪴', color: '#19c37d', type: 'question', priority: 'low', urgency: 55, chip: 'Your reminder', createdAt: ago(5),
        title: 'Water the plants', body: 'Example card: reminders you add yourself, once or on repeat.', generic: true }),
    ].map((c) => normalize(c, c.service));
  }

  // ---------- services registry (services.js registers them) ----------
  const services = new Map();
  const registerService = (def) => services.set(def.id, def);

  // ---------- sync ----------
  const cacheAll = () => ls.get('cache', {});
  function setCache(id, entry) { const c = cacheAll(); c[id] = entry; ls.set('cache', c); }
  const STALE_MS = 15 * 60 * 1000;
  async function syncService(id, { force = false } = {}) {
    const def = services.get(id); const st = svcState(id);
    if (!def || !st || st.on === false || def.status === 'soon' || !def.fetch) return;
    const c = cacheAll()[id];
    const stale = def.staleMs != null ? def.staleMs : STALE_MS;
    if (!force && c && Date.now() - c.at < stale && c.day === deckDay()) return;
    if (def.needsSetup && def.needsSetup()) { updateService(id, { error: 'Needs a one-time setup by the person who shared this app.', needsSetup: true }); return; }
    try {
      const cards = await Promise.race([def.fetch(st.cfg || {}, ctx(id)), sleep(def.timeout || 10000).then(() => { throw new FriendlyError(`${def.name} took too long`); })]);
      setCache(id, { at: Date.now(), day: deckDay(), cards: (cards || []).map((x) => normalize(x, id)) });
      updateService(id, { lastSync: new Date().toISOString(), error: '', needsAuth: false });
    } catch (e) {
      updateService(id, { error: e.message || String(e), needsAuth: !!e.needsAuth, lastTry: new Date().toISOString() });
      if (e.needsAuth && def.reauthCard) setCache(id, { at: Date.now(), day: deckDay(), cards: [normalize(def.reauthCard(), id)] });
    }
  }
  async function syncAll(opts) { const s = settings(); await Promise.all(Object.keys(s.services).map((id) => syncService(id, opts))); }

  const pendingMeta = {};
  // per-service context handed to connectors
  function ctx(id) {
    return {
      id, http, settings, deckDay, nextDeckAt, ymd, startOfDay, addDays, fmtTime, fmtDay, relIn, strip, clip, uid, loadScript, FriendlyError, CFG, TZ,
      store: { get: (k, d) => ls.get(`svc.${id}.${k}`, d), set: (k, v) => ls.set(`svc.${id}.${k}`, v) },
      // before a service is added (wizard test), keep its notes aside instead of adding it
      save: (patch) => (svcState(id) ? updateService(id, patch) : Object.assign(pendingMeta[id] = pendingMeta[id] || {}, patch)),
    };
  }

  // ---------- states (answered / snoozed) + answers ----------
  const states = () => ls.get('states', {});
  const setStates = (s) => ls.set('states', s);
  const answers = () => ls.get('answers', []);
  const setAnswers = (a) => ls.set('answers', a.slice(-400));
  function visible(card, st, now) {
    const x = st[card.id]; if (!x) return true;
    if (x.status === 'answered') return false;
    if (x.status === 'snoozed') return Date.parse(x.until) <= now.getTime();
    return true;
  }
  function pruneStates() { const st = states(); const cut = Date.now() - 45 * 86400e3; let ch = false; for (const [k, v] of Object.entries(st)) if (Date.parse(v.at) < cut) { delete st[k]; ch = true; } if (ch) setStates(st); }

  // demo answers live in memory only (every reload = fresh sample deck)
  const demo = { answers: [] };

  async function buildDeck() {
    const now = new Date();
    const s = settings();
    if (!s.setupDone) {
      const done = new Set(demo.answers.filter((a) => !a.undone).map((a) => a.cardId));
      return [...sampleDeck(now), normalize(feedbackCard(ymd(now)), 'morning-deck')].filter((c) => !done.has(c.id));
    }
    await syncAll();
    const cache = cacheAll(); const st = states();
    let cards = [];
    for (const [id, v] of Object.entries(s.services)) { if (v.on === false || !cache[id]) continue; cards.push(...cache[id].cards); }
    for (const def of services.values()) if (def.localCards && s.services[def.id] && s.services[def.id].on !== false) cards.push(...(def.localCards(s.services[def.id].cfg || {}, ctx(def.id)) || []).map((c) => normalize(c, def.id)));
    const seen = new Set();
    cards = cards.filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return visible(c, st, now); });
    cards = sortCards(cards);
    const fb = normalize(feedbackCard(deckDay(now)), 'morning-deck');
    if (visible(fb, st, now)) cards.push(fb);
    window.__mdfLastDeck = cards;
    return cards;
  }
  function findCard(id) {
    const hit = (window.__mdfLastDeck || []).find((c) => c.id === id); if (hit) return hit;
    const s = settings(); const now = new Date();
    if (!s.setupDone) return [...sampleDeck(now), normalize(feedbackCard(ymd(now)), 'morning-deck')].find((c) => c.id === id) || null;
    // answers queued offline can arrive before the deck is rebuilt: look in the cache and local cards too
    const fb = normalize(feedbackCard(deckDay(now)), 'morning-deck'); if (fb.id === id) return fb;
    for (const v of Object.values(cacheAll())) { const c = (v.cards || []).find((x) => x.id === id); if (c) return c; }
    for (const def of services.values()) if (def.localCards && s.services[def.id]) { const c = (def.localCards(s.services[def.id].cfg || {}, ctx(def.id)) || []).find((x) => x.id === id); if (c) return normalize(c, def.id); }
    return null;
  }

  // ---------- swipe actions (opt-in, reversible only) ----------
  async function runAction(card, gesture) {
    const g = card.gestures[gesture] || {};
    if (!g.action || card.sample) return null;
    const def = services.get(card.service); if (!def || !def.actions || !def.actions[g.action]) return null;
    const a = def.actions[g.action];
    const st = svcState(card.service) || {};
    if (!a.local && !st.act) return null; // default: record only
    const result = await a.run(card, ctx(card.service));
    return { service: card.service, action: g.action, result: result === undefined ? true : result, local: !!a.local };
  }
  async function undoAction(card, act) {
    const def = services.get(act.service); const a = def && def.actions && def.actions[act.action];
    if (a && a.undo) await a.undo(card, act.result, ctx(act.service));
  }

  // ---------- the /api/* emulation used by app.js ----------
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function api(path, opts = {}) {
    const url = new URL(String(path), location.href); const p = url.pathname.replace(/^.*\/api\//, '/api/');
    const method = (opts.method || 'GET').toUpperCase();
    let body = {}; if (typeof opts.body === 'string' && opts.body) { try { body = JSON.parse(opts.body); } catch { body = {}; } }
    const s = settings();
    if (p === '/api/config') {
      const next = nextDeckAt();
      return reply(200, { demo: !s.setupDone, friends: true, greetingName: s.name || '', uploads: true, maxPhotos: 6,
        clearedNote: !s.setupDone ? 'These were sample cards, and nothing was saved. Tap “Make it mine” to build your own deck.' : `Saved on this phone. Your next deck is ready ${next.getDate() === new Date().getDate() ? 'at' : 'tomorrow at'} ${fmtTime(next)}.`,
        snoozeNote: ` · back ${nextDeckAt().getDate() === new Date().getDate() ? 'at' : 'tomorrow'} ${fmtTime(nextDeckAt())}` });
    }
    if (p === '/api/health') return reply(200, { ok: true, local: true });
    if (p === '/api/uploads' && method === 'POST') {
      const blob = opts.body instanceof Blob ? opts.body : null; if (!blob) return reply(400, { error: 'no photo' });
      const h = new Headers(opts.headers || {});
      const id = 'ph_' + (h.get('X-Client-Upload-Id') || uid()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      await idb.put({ id, blob, mime: blob.type || h.get('Content-Type'), size: blob.size, width: +h.get('X-Image-Width') || null, height: +h.get('X-Image-Height') || null, at: new Date().toISOString() });
      return reply(201, { id, mime: blob.type, size: blob.size });
    }
    if (p === '/api/deck' && method === 'GET') {
      const cards = await buildDeck();
      return reply(200, { generatedAt: new Date().toISOString(), count: cards.length, cards });
    }
    if (p === '/api/answers' && method === 'GET') {
      const since = Date.parse(url.searchParams.get('since') || 0) || 0;
      const list = (s.setupDone ? answers() : demo.answers).filter((a) => !a.undone && Date.parse(a.recordedAt) >= since);
      return reply(200, { count: list.length, answers: list });
    }
    if (p === '/api/answers' && method === 'POST') {
      const list0 = s.setupDone ? answers() : demo.answers;
      const dup = body.clientAnswerId && list0.find((x) => x.clientAnswerId === body.clientAnswerId);
      if (dup) return reply(200, { answer: dup, card: null, duplicate: true });
      const card = findCard(body.cardId);
      if (!card) return reply(404, { error: 'that card is no longer here' });
      const g = card.gestures[body.gesture]; if (!g) return reply(400, { error: 'unknown gesture' });
      const now = new Date().toISOString();
      const a = { id: 'ans_' + uid().slice(0, 12), cardId: card.id, service: card.service, source: card.source, cardTitle: card.title, sample: !!card.sample, builtin: !!card.builtin,
        gesture: body.gesture, label: g.label, clientAnswerId: body.clientAnswerId, value: body.value !== undefined ? body.value : g.value, text: body.text, attachments: body.attachments || [], answeredAt: body.answeredAt || now, recordedAt: now };
      if (!s.setupDone) { demo.answers.push(a); }
      else {
        try { const act = await runAction(card, body.gesture); if (act) { a.act = act; } }
        catch (e) { a.actError = e.message || String(e); emit('mdf:toast', { msg: `Recorded, but ${card.source} didn’t take the action: ${clip(a.actError, 90)}`, color: '#ff4f6d', ms: 4200 }); }
        if (a.act && !a.act.local) emit('mdf:toast', { msg: `${g.label} · done in ${card.source}`, color: '#19c37d', ms: 2200 });
        const st = states();
        st[card.id] = g.snooze ? { status: 'snoozed', until: nextDeckAt().toISOString(), at: now, answerId: a.id } : { status: 'answered', at: now, answerId: a.id };
        setStates(st);
        setAnswers([...answers(), a]);
      }
      if (card.builtin && ['right', 'left', 'tap3'].includes(body.gesture)) emit('mdf:feedback', { answer: a, card });
      return reply(201, { answer: a, card });
    }
    if (p === '/api/answers/undo' && method === 'POST') {
      const list = s.setupDone ? answers() : demo.answers;
      const t = [...list].reverse().find((x) => !x.undone && (!body.answerId || x.id === body.answerId));
      if (!t) return reply(404, { error: 'nothing to undo' });
      if (t.act) {
        const card = findCard(t.cardId) || { id: t.cardId, service: t.service, gestures: {} };
        try { await undoAction(card, t.act); } catch (e) { return reply(502, { error: `couldn’t undo in ${t.source}: ${e.message}` }); }
      }
      t.undone = true;
      if (s.setupDone) { setAnswers(list); const st = states(); delete st[t.cardId]; setStates(st); }
      return reply(201, { undo: { gesture: 'undo', undoes: t.id }, card: null });
    }
    return reply(404, { error: 'not found' });
  }
  window.MD_API_FETCH = (path, opts) => api(path, opts).catch((e) => reply(500, { error: e.message || String(e) }));

  // ---------- export / import / reset ----------
  function exportData({ includeAnswers = true } = {}) {
    return { app: 'morning-deck-friends', version: 1, exportedAt: new Date().toISOString(), settings: settings(), states: states(), answers: includeAnswers ? answers() : [], inbox: ls.get('svc.inbox.messages', []) };
  }
  function importData(obj) {
    if (!obj || obj.app !== 'morning-deck-friends' || !obj.settings || typeof obj.settings !== 'object') throw new Error('That file isn’t a Morning Deck for Friends export.');
    const s = Object.assign(defaults(), obj.settings);
    if (typeof s.services !== 'object' || !Array.isArray(s.manual)) throw new Error('The export looks damaged (services/manual missing).');
    saveSettings(s); ls.set('states', obj.states || {}); ls.set('answers', Array.isArray(obj.answers) ? obj.answers : []);
    if (Array.isArray(obj.inbox)) ls.set('svc.inbox.messages', obj.inbox);
    ls.del('cache');
    return s;
  }
  async function resetAll() {
    for (const k of Object.keys(localStorage)) if (k.startsWith(P) || k.startsWith('md_') || k.startsWith('msal.') || k.includes('login.windows.net') || k.includes('login.microsoftonline.com')) localStorage.removeItem(k);
    try { sessionStorage.clear(); } catch (_) {}
    await idb.wipe();
    try { await new Promise((res) => { const r = indexedDB.deleteDatabase('morning-deck'); r.onsuccess = r.onerror = r.onblocked = () => res(); }); } catch (_) {}
  }
  async function photoBlobs(ids) { const out = []; for (const id of ids || []) { const p = await idb.get(id).catch(() => null); if (p && p.blob) out.push(p); } return out; }

  pruneStates();
  window.MDF = { CFG, TZ, ls, idb, http, settings, saveSettings, updateService, removeService, svcState, services, registerService, syncService, syncAll, buildDeck, cacheAll, setCache,
    PRESETS, pendingMeta, effectiveGestures, startOfDay, addDays, deckDay, nextDeckAt, normalize, sampleDeck, feedbackCard, exportData, importData, resetAll, photoBlobs, ctx, emit, uid, ymd, fmtTime, fmtDay, relIn, strip, clip, loadScript, FriendlyError, answers, states };
})();
