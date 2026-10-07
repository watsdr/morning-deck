/* Morning Deck — swipe-card client. Plain JS, no build step.
 * SAFETY: every gesture only POSTs a decision to this app's own /api/answers log.
 * Nothing here sends messages, buys, submits, or calls any outside service. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const TZ = 'America/New_York';
  const DIRS = ['right', 'left', 'up', 'down'];
  const COLORS = { right: '#19c37d', left: '#ff4f6d', up: '#ffaa1f', down: '#8b7cf6', tap3: '#38b6ff', undo: '#b08b2e' };
  const ICONS = {
    right: '<path d="M5 12h14M13 6l6 6-6 6"/>', left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  };
  const TYPE_LABEL = { question: 'Question', choice: 'Choice', info: 'FYI' };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };

  const MAX_PHOTOS = 6, MAX_EDGE = 1600, PHOTO_QUALITY = 0.85, MAX_UPLOAD = 8 * 1024 * 1024;
  const state = { deck: [], history: [], session: [], loaded: false, busy: false, taps: [], sheetCard: null, sheetGesture: 'tap3', sheetOpenedAt: 0, locked: false, photos: [] };
  const el = {
    stack: $('#stack'), cleared: $('#cleared'), app: $('#app'), count: $('#countNum'), counter: $('#counter'),
    progress: $('#progressFill'), tint: $('#tint'), toast: $('#toast'), undo: $('#btnUndo'), status: $('#statusPill'),
    sheetWrap: $('#sheetWrap'), sheetScroll: $('#sheetScroll'), reply: $('#replyText'), save: $('#sheetSave'),
    photoBtn: $('#photoBtn'), photoBtnLabel: $('#photoBtnLabel'), photoInput: $('#photoInput'), thumbs: $('#thumbs'),
  };

  // ---------- helpers ----------
  function h(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'style') n.style.cssText = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const svgIcon = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = d; return s; };
  function fmtTime(iso) {
    const d = new Date(iso);
    const t = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    const mins = Math.round((Date.now() - d) / 60000);
    let rel = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
    const sameDay = d.toLocaleDateString('en-US', { timeZone: TZ }) === new Date().toLocaleDateString('en-US', { timeZone: TZ });
    return sameDay ? `${t} · ${rel}` : `${d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })}, ${t}`;
  }
  // Display name comes from the server (MD_GREETING_NAME); cached so the header doesn't flicker on the next launch.
  const NAME_KEY = 'md_greeting_name';
  const config = { demo: false, uploads: true, greetingName: (() => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } })() };
  function greeting() {
    const now = new Date();
    const hr = +now.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
    const part = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const date = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
    $('#greeting').textContent = `${part}${config.greetingName ? `, ${config.greetingName}` : ''} · ${date}`;
  }
  async function loadConfig() {
    try {
      const c = await api('/api/config');
      Object.assign(config, { demo: !!c.demo, uploads: c.uploads !== false, greetingName: c.greetingName || '' });
      try { localStorage.setItem(NAME_KEY, config.greetingName); } catch (_) {}
    } catch (_) { /* older server or offline: keep cached values */ }
    greeting();
    $('#demoBanner').hidden = !config.demo;
    document.documentElement.classList.toggle('demo', config.demo);
    el.photoBtn.closest('.photo-row').hidden = !config.uploads;
  }
  let toastTimer;
  function toast(msg, color = '#fff', ms = 1900) {
    el.toast.innerHTML = '';
    el.toast.append(h('i', { style: `--c:${color}` }), msg);
    el.toast.classList.toggle('long', ms > 2500);
    el.toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }
  function setStatus(msg) { el.status.hidden = !msg; el.status.textContent = msg || ''; }

  // ---------- API + offline outbox ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 401) { showLocked(); const e = new Error('unauthorized'); e.status = 401; throw e; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  // transient = worth retrying later (offline, tunnel/server down, rate limited)
  const transient = (e) => !e.status || e.status >= 500 || e.status === 408 || e.status === 429;
  // Upload one processed photo. X-Client-Upload-Id makes retries idempotent (same photo -> same upload id).
  async function uploadPhoto(p) {
    const res = await fetch('/api/uploads', { method: 'POST', credentials: 'same-origin', body: p.blob,
      headers: { 'Content-Type': p.mime || 'application/octet-stream', 'X-Client-Upload-Id': p.clientUploadId, ...(p.width ? { 'X-Image-Width': String(p.width), 'X-Image-Height': String(p.height) } : {}) } });
    if (res.status === 401) { showLocked(); const e = new Error('unauthorized'); e.status = 401; throw e; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
    return data;
  }
  async function sendAnswer(payload, photos) {
    const body = { ...payload };
    if (photos && photos.length) { body.attachments = []; for (const p of photos) body.attachments.push((await uploadPhoto(p)).id); }
    return api('/api/answers', { method: 'POST', body: JSON.stringify(body) });
  }

  // Plain answers queue in localStorage; replies with photos queue in IndexedDB (blobs included) so nothing is lost offline.
  const OUTBOX = 'md_outbox_v1';
  const outbox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX)) || []; } catch { return []; } };
  const setOutbox = (l) => localStorage.setItem(OUTBOX, JSON.stringify(l));
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('morning-deck', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
    }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('outbox', mode); const req = fn(t.objectStore('outbox')); t.oncomplete = () => res(req && req.result); t.onerror = t.onabort = () => rej(t.error); }); };
    return { put: (v) => tx('readwrite', (st) => st.put(v)), del: (k) => tx('readwrite', (st) => st.delete(k)), all: () => tx('readonly', (st) => st.getAll()).catch(() => []) };
  })();
  let flushing = null, retryTimer;
  function flushOutbox() { return flushing || (flushing = doFlush().finally(() => { flushing = null; })); }
  async function doFlush() {
    let list = outbox();
    while (list.length) {
      try { await api('/api/answers', { method: 'POST', body: JSON.stringify(list[0]) }); }
      catch (e) { if (transient(e)) break; /* still offline */ }
      list = outbox().filter((p) => p.clientAnswerId !== list[0].clientAnswerId); setOutbox(list);
    }
    let photoItems = await idb.all(), failed = 0;
    for (const it of photoItems) {
      if (list.length) break; // offline: don't hammer
      try { await sendAnswer(it.payload, it.photos); await idb.del(it.id); }
      catch (e) {
        if (transient(e)) break;
        if (e.status === 401) break;
        failed++; await idb.put({ ...it, error: e.message, failedAt: new Date().toISOString() }).catch(() => {}); // keep it, never drop photos
      }
    }
    photoItems = await idb.all();
    const waiting = list.length + photoItems.length;
    const pics = photoItems.reduce((n, it) => n + it.photos.length, 0);
    const bad = photoItems.find((it) => it.error && failed);
    setStatus(bad ? `Couldn't sync a reply with photos (${bad.error}) · tap to retry`
      : waiting ? `Offline · ${waiting} answer${waiting > 1 ? 's' : ''}${pics ? ` (${pics} photo${pics > 1 ? 's' : ''})` : ''} waiting to sync` : '');
    clearTimeout(retryTimer);
    if (waiting) retryTimer = setTimeout(flushOutbox, 30000);
    return waiting;
  }

  async function loadDeck({ initial = false } = {}) {
    try {
      const data = await api('/api/deck');
      const queued = new Set([...outbox(), ...(await idb.all()).map((it) => it.payload)].map((p) => p.cardId));
      state.deck = data.cards.filter((c) => !queued.has(c.id));
      state.loaded = true;
      if (!state.session.length && !state.deck.length) loadTodaySummary();
      render({ deal: initial });
    } catch (e) {
      if (e.status === 401) return;
      state.loaded = true; setStatus('Offline · showing nothing new'); render();
    }
  }
  async function loadTodaySummary() {
    try {
      const now = new Date();
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
      const since = new Date(new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`).getTime() - 14 * 3600e3); // generous window
      const data = await api('/api/answers?since=' + encodeURIComponent(since.toISOString()));
      state.todayAnswers = data.answers.filter((a) => new Date(a.recordedAt).toLocaleDateString('en-US', { timeZone: TZ }) === now.toLocaleDateString('en-US', { timeZone: TZ }));
      if (!state.deck.length) renderCleared(false);
    } catch (_) {}
  }

  // ---------- card DOM ----------
  function buildCard(card) {
    const g = card.gestures;
    const accent = card.color || '#7c6cf2';
    const node = h('article', { class: 'card', 'data-id': card.id, 'data-type': card.type, 'data-builtin': card.builtin ? '1' : null, style: `--accent:${accent}`, 'aria-label': `${card.source}: ${card.title}` });
    node.append(h('div', { class: 'card-wash' }), h('div', { class: 'card-ring' }));
    if (card.sample) node.append(h('div', { class: 'ribbon', title: 'Example data, not a real request' }, 'SAMPLE'));
    node.append(h('header', { class: 'card-head' },
      h('div', { class: 'avatar' }, card.emoji || '🤖'),
      h('div', { class: 'who' }, h('div', { class: 'bot' }, card.source), h('div', { class: 'meta' }, card.builtin ? 'Your daily check-in · last card' : fmtTime(card.createdAt) + (card.sample ? ' · sample' : '')))));
    node.append(card.builtin
      ? h('div', { class: 'chips' }, h('span', { class: 'chip' }, 'Feedback'), h('span', { class: 'chip chip-soft' }, '1 minute'))
      : h('div', { class: 'chips' },
        h('span', { class: 'chip' }, TYPE_LABEL[card.type] || card.type),
        h('span', { class: `chip prio-${card.priority}` }, card.priority === 'high' ? 'High priority' : card.priority === 'low' ? 'Low' : 'Normal')));
    node.append(h('h2', {}, card.title));
    if (card.body) node.append(h('p', { class: 'body' }, card.body));
    if (card.type === 'choice') {
      const ul = h('ul', { class: 'options' });
      for (const d of ['right', 'left', 'down', 'up']) {
        if (!g[d] || g[d].disabled) continue;
        const a = h('span', { class: 'arrow', style: `background:${COLORS[d]}` }); a.append(svgIcon(ICONS[d])); a.firstChild.style.cssText = 'width:15px;height:15px;fill:none;stroke:#fff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round';
        ul.append(h('li', {}, a, g[d].label));
      }
      node.append(ul);
    }
    else if (card.details) node.append(h('div', { class: 'peek' }, card.details.replace(/^EXAMPLE DATA[^\n]*\n+/i, '')));
    if (card.builtin) {
      node.append(h('div', { class: 'fb-ideas', 'aria-hidden': 'true' },
        [['💡', 'Ideas'], ['🐞', 'Bugs'], ['✨', 'Wishes'], ['📷', 'Screenshots']].map(([e, t], i) => h('span', { style: `--i:${i}` }, h('b', {}, e), t))));
      node.append(h('div', { class: 'fb-sun', 'aria-hidden': 'true' }, h('i'), h('i')));
    }
    node.append(h('div', { class: 'spacer' }));
    node.append(h('div', { class: 'tap-hint' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
      h('span', { html: card.builtin ? 'Triple-tap to <b>suggest</b> · photos welcome' : `Triple-tap for ${card.details ? '<b>details</b> &amp; ' : ''}a custom reply` })));
    for (const d of DIRS) {
      if (!g[d] || g[d].disabled) continue;
      const hint = h('div', { class: `hint hint-${d}` }); hint.append(svgIcon(ICONS[d]), h('span', {}, g[d].label));
      node.append(hint);
      const label = g[d].label;
      node.append(h('div', { class: `stamp stamp-${d}`, style: `--fs:${label.length > 11 ? 22 : label.length > 8 ? 26 : label.length > 5 ? 32 : 42}px` }, label));
    }
    node.append(h('div', { class: 'stamp stamp-tap3', style: '--fs:34px' }, card.builtin ? 'Thanks!' : 'Replied'));
    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onCancel);
    node.addEventListener('lostpointercapture', onCancel);
    return node;
  }
  function skeleton() {
    const s = h('article', { class: 'card skeleton', 'data-depth': '0', style: '--depth:0' });
    s.append(h('div', { class: 'card-head' }, h('div', { class: 'avatar sk' }), h('div', { class: 'who' }, h('div', { class: 'sk', style: 'height:14px;width:55%' }), h('div', { class: 'sk', style: 'height:11px;width:35%;margin-top:8px' }))),
      h('div', { class: 'sk', style: 'height:26px;width:85%;margin-top:30px' }), h('div', { class: 'sk', style: 'height:26px;width:60%;margin-top:10px' }),
      h('div', { class: 'sk', style: 'height:14px;width:95%;margin-top:22px' }), h('div', { class: 'sk', style: 'height:14px;width:88%;margin-top:10px' }), h('div', { class: 'sk', style: 'height:14px;width:70%;margin-top:10px' }));
    return s;
  }

  // ---------- render ----------
  function render({ deal = false } = {}) {
    if (state.locked) return;
    const visible = state.deck.slice(0, 4);
    const existing = new Map([...el.stack.children].filter((n) => n.dataset.id && !n.classList.contains('flying')).map((n) => [n.dataset.id, n]));
    [...el.stack.children].forEach((n) => { if (!n.dataset.id) n.remove(); });
    visible.forEach((card, i) => {
      let node = existing.get(card.id);
      existing.delete(card.id);
      const fresh = !node;
      if (fresh) {
        node = buildCard(card);
        node.dataset.depth = '3'; node.style.setProperty('--depth', 3);
        el.stack.appendChild(node);
        node.getBoundingClientRect();
      }
      node.classList.remove('dragging');
      node.style.transform = ''; node.style.opacity = '';
      node.style.zIndex = String(20 - i);
      const apply = () => { node.dataset.depth = String(i); node.style.setProperty('--depth', i); };
      if (fresh && deal && !reduced()) setTimeout(apply, 90 * (visible.length - i)); else apply();
    });
    existing.forEach((n) => n.remove());
    const top = el.stack.querySelector('.card[data-depth="0"]:not(.flying)') || el.stack.querySelector(`.card[data-id="${CSS.escape(visible[0]?.id || '')}"]`);
    // labels on fallback buttons
    const g = state.deck[0]?.gestures;
    for (const d of DIRS) {
      const btn = document.querySelector(`.act[data-g="${d}"]`);
      btn.querySelector('span').textContent = g ? g[d].label : { right: 'Yes', left: 'No', up: 'Later', down: 'Skip' }[d];
      btn.disabled = !g || !!g[d].disabled;
    }
    const t3 = document.querySelector('.act-tap3');
    t3.disabled = !g; t3.querySelector('span').textContent = (g && g.tap3 && g.tap3.label) || 'Reply';
    el.undo.disabled = !state.history.length;
    // counters
    const n = state.deck.length;
    if (el.count.textContent !== String(n)) { el.count.textContent = n; el.counter.classList.remove('bump'); void el.counter.offsetWidth; el.counter.classList.add('bump'); }
    const done = state.session.length;
    el.progress.style.width = done + n ? `${(done / (done + n)) * 100}%` : (state.loaded ? '100%' : '0%');
    // cleared / loading
    if (!state.loaded) { el.stack.append(skeleton()); el.cleared.hidden = true; return; }
    const isCleared = n === 0;
    el.app.classList.toggle('is-cleared', isCleared);
    if (isCleared) renderCleared(false); else el.cleared.hidden = true;
    return top;
  }

  function renderCleared(celebrate) {
    el.cleared.hidden = false;
    const list = state.session.length ? state.session.map((e) => ({ card: e.card, gesture: e.gesture, label: e.card.gestures[e.gesture].label, text: e.payload.text, pics: e.photos.length }))
      : (state.todayAnswers || []).map((a) => ({ card: { title: a.cardTitle, source: a.source, emoji: a.builtin ? '🌅' : '' }, gesture: a.gesture, label: a.label, text: a.text, pics: (a.attachments || []).length }));
    $('#clearedSub').textContent = list.length
      ? `You cleared ${list.length} card${list.length > 1 ? 's' : ''}${state.session.length ? '' : ' today'}. ${config.demo ? 'This is a demo, so nothing was saved. Reload for a fresh deck.' : 'Your bots will pick up your answers.'}`
      : 'Nothing waiting on you right now. Enjoy your coffee ☕';
    const chips = $('#summaryChips'); chips.innerHTML = '';
    const snoozed = (x) => x.gesture === 'up' && (x.card.gestures ? x.card.gestures.up.snooze : x.label === 'Later');
    const groups = [
      ['decided', COLORS.right, list.filter((x) => x.gesture !== 'tap3' && !snoozed(x)).length],
      ['back tomorrow', COLORS.up, list.filter(snoozed).length],
      ['replied', COLORS.tap3, list.filter((x) => x.gesture === 'tap3').length],
    ].filter((g) => g[2]);
    groups.forEach(([name, color, c], i) => chips.append(h('span', { class: 's', style: `--c:${color};animation-delay:${0.45 + i * 0.07}s` }, h('b', {}, c), name)));
    const ul = $('#summaryList'); ul.innerHTML = '';
    list.forEach((x, i) => ul.append(h('li', { style: `animation-delay:${0.55 + i * 0.07}s` },
      h('span', { class: 'e' }, x.card.emoji || '•'),
      h('div', { class: 't' }, h('div', {}, x.card.title), h('small', {}, [x.card.source, x.pics ? `📷 ${x.pics}` : '', x.text ? `“${x.text}”` : ''].filter(Boolean).join(' · '))),
      h('span', { class: 'a', style: `--c:${COLORS[x.gesture]}` }, x.gesture === 'tap3' ? 'Replied' : x.label))));
    if (celebrate) confetti();
  }

  function showLocked() {
    state.locked = true;
    el.stack.innerHTML = '';
    el.cleared.hidden = false;
    el.cleared.innerHTML = '<div class="sunrise"><div class="sun"></div><div class="horizon"></div></div><h2>Locked</h2><p class="cleared-sub">Open Morning Deck with your private link (ending in <code>?token=…</code>) to sign this device in.</p>';
  }

  // ---------- drag physics ----------
  let drag = null;
  let topAnim = null;
  const rubber = (d, limit) => { const a = Math.abs(d); return a <= limit ? d : Math.sign(d) * (limit + (a - limit) * 0.35); };
  function intent(node, dx, dy) {
    const w = node.offsetWidth, hgt = node.offsetHeight;
    const px = Math.abs(dx) / (w * 0.32), py = Math.abs(dy) / (hgt * 0.2);
    if (Math.max(px, py) < 0.06) return { dir: null, p: 0 };
    return px >= py ? { dir: dx > 0 ? 'right' : 'left', p: px } : { dir: dy < 0 ? 'up' : 'down', p: py };
  }
  function topCardData(node) { return state.deck.find((c) => c.id === node.dataset.id); }

  function setFeedback(node, dir, p) {
    const q = clamp(p);
    const card = topCardData(node);
    for (const s of node.querySelectorAll('.stamp')) {
      const d = s.className.match(/stamp-(\w+)/)[1];
      const on = d === dir;
      const o = on ? clamp((p - 0.12) / 0.6) : 0;
      s.style.opacity = o;
      s.style.setProperty('--s', on ? (1.35 - 0.35 * clamp((p - 0.12) / 0.6)).toFixed(3) : 1);
    }
    for (const hn of node.querySelectorAll('.hint')) hn.classList.toggle('active', !!dir && hn.classList.contains(`hint-${dir}`) && p > 0.15);
    const wash = node.querySelector('.card-wash'), ring = node.querySelector('.card-ring');
    if (dir && card && !(card.gestures[dir] || {}).disabled) {
      const c = COLORS[dir];
      const to = { right: 'to right', left: 'to left', up: 'to top', down: 'to bottom' }[dir] || 'to bottom';
      wash.style.background = `linear-gradient(${to}, transparent 25%, ${rgba(c, 0.32)} 100%)`;
      wash.style.opacity = q;
      ring.style.setProperty('--glow', rgba(c, 0.85)); ring.style.opacity = q;
      node.style.boxShadow = `0 1px 0 rgba(255,255,255,.9) inset, 0 0 ${30 + 40 * q}px ${rgba(c, 0.55 * q)}, 0 30px 60px -18px rgba(14,6,48,.55)`;
      el.tint.style.setProperty('--tint', rgba(c, 0.55)); el.tint.style.opacity = q * 0.8;
    } else {
      wash.style.opacity = 0; ring.style.opacity = 0; node.style.boxShadow = ''; el.tint.style.opacity = 0;
    }
    for (const d of DIRS) {
      const b = document.querySelector(`.act[data-g="${d}"]`);
      b.style.transform = d === dir ? `scale(${1 + 0.18 * q})` : '';
    }
    // cards behind rise as the top card leaves
    const behind = [...el.stack.querySelectorAll('.card:not(.flying)')].filter((n) => n !== node);
    for (const b of behind) {
      const depth = +b.dataset.depth; if (!depth) continue;
      const eff = depth - (dir ? q * 0.6 : 0);
      b.classList.toggle('dragging', q > 0);
      b.style.transform = q > 0 ? `translate3d(0, ${eff * 15}px, 0) scale(${1 - eff * 0.05})` : '';
      if (depth === 3) b.style.opacity = q > 0 ? q * 0.6 : '';
    }
    if (dir && p >= 1 && !node._armed) { node._armed = true; buzz(8); } else if (p < 1) node._armed = false;
  }
  function clearFeedback(node) {
    setFeedback(node, null, 0);
    node.style.boxShadow = '';
    for (const b of el.stack.querySelectorAll('.card')) if (b !== node) { b.classList.remove('dragging'); b.style.transform = ''; b.style.opacity = ''; }
  }
  function place(node, x, y, rot) { node.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rot}deg)`; }

  function onDown(e) {
    const node = e.currentTarget;
    if (node.dataset.depth !== '0' || node.classList.contains('flying') || state.busy || state.sheetCard) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (topAnim) { topAnim.cancel(); topAnim = null; }
    node.setPointerCapture(e.pointerId);
    const r = node.getBoundingClientRect();
    const now = e.timeStamp || performance.now();
    const cur = node._pos || { x: 0, y: 0 };
    drag = { node, id: e.pointerId, x0: e.clientX - cur.x, y0: e.clientY - cur.y, sx: e.clientX, sy: e.clientY, t0: now, x: cur.x, y: cur.y, rot: 0, moved: false,
      samples: [{ x: e.clientX, y: e.clientY, t: now }], sign: (e.clientY - r.top) > r.height * 0.55 ? -1 : 1, w: r.width, h: r.height };
    node.classList.add('dragging');
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const now = e.timeStamp || performance.now();
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 9) drag.moved = true;
    if (!drag.moved) return;
    drag.samples.push({ x: e.clientX, y: e.clientY, t: now });
    while (drag.samples.length > 2 && now - drag.samples[0].t > 110) drag.samples.shift();
    const rx = rubber(e.clientX - drag.x0, drag.w * 0.85), ry = rubber(e.clientY - drag.y0, drag.h * 0.42);
    drag.x = rx; drag.y = ry; drag.rot = (rx / drag.w) * 17 * drag.sign;
    place(drag.node, rx, ry, drag.rot);
    drag.node._pos = { x: rx, y: ry };
    const it = intent(drag.node, rx, ry);
    setFeedback(drag.node, it.dir, it.p);
  }
  function velocity(samples) {
    if (samples.length < 2) return { x: 0, y: 0 };
    const a = samples[0], b = samples[samples.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt }; // px per ms
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    try { d.node.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!d.moved && (e.timeStamp || performance.now()) - d.t0 < 400) { d.node.classList.remove('dragging'); d.node._pos = null; d.node.style.transform = ''; return handleTap(e, d.node); }
    const v = velocity(d.samples);
    const it = intent(d.node, d.x, d.y);
    let dir = null;
    if (it.dir && it.p >= 1) dir = it.dir;
    else if (Math.abs(v.x) >= Math.abs(v.y)) { if (Math.abs(v.x) > 0.45 && Math.abs(d.x) > 36 && Math.sign(v.x) === Math.sign(d.x)) dir = d.x > 0 ? 'right' : 'left'; }
    else if (Math.abs(v.y) > 0.45 && Math.abs(d.y) > 36 && Math.sign(v.y) === Math.sign(d.y)) dir = d.y < 0 ? 'up' : 'down';
    state.lastRelease = { v, x: d.x, y: d.y, p: it.p, dir, n: d.samples.length, span: d.samples.length > 1 ? d.samples[d.samples.length - 1].t - d.samples[0].t : 0 };
    const card = topCardData(d.node);
    const g = dir && card ? card.gestures[dir] || {} : {};
    if (dir && card && !g.disabled && g.reply) { springBack(d.node, { x: d.x, y: d.y, rot: d.rot }, v); openSheet(card, { gesture: dir }); } // e.g. "Something's off": explain first
    else if (dir && card && !g.disabled) flyOut(d.node, dir, { x: d.x, y: d.y, rot: d.rot }, v);
    else springBack(d.node, { x: d.x, y: d.y, rot: d.rot }, v);
  }
  function onCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    springBack(d.node, { x: d.x, y: d.y, rot: d.rot }, { x: 0, y: 0 });
  }

  function animate(step) {
    let raf, last = performance.now(), stopped = false;
    const loop = (t) => { if (stopped) return; const dt = Math.min(0.032, (t - last) / 1000); last = t; if (step(dt) === false) return; raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return { cancel() { stopped = true; cancelAnimationFrame(raf); } };
  }
  function springBack(node, from, v) {
    node.classList.add('dragging');
    if (reduced()) { node._pos = null; node.style.transform = ''; node.classList.remove('dragging'); clearFeedback(node); return; }
    let x = from.x, y = from.y, r = from.rot, vx = v.x * 1000, vy = v.y * 1000, vr = 0;
    const k = 380, c = 24;
    topAnim = animate((dt) => {
      vx += (-k * x - c * vx) * dt; x += vx * dt;
      vy += (-k * y - c * vy) * dt; y += vy * dt;
      vr += (-k * r - c * vr) * dt; r += vr * dt;
      place(node, x, y, r); node._pos = { x, y };
      const it = intent(node, x, y); setFeedback(node, it.dir, it.p);
      if (Math.abs(x) < 0.4 && Math.abs(y) < 0.4 && Math.abs(vx) + Math.abs(vy) < 12) {
        node._pos = null; node.style.transform = ''; node.classList.remove('dragging'); clearFeedback(node); topAnim = null; return false;
      }
    });
  }

  function flyOut(node, dir, from, v, opts = {}) {
    const card = topCardData(node);
    if (!card) return;
    node.classList.add('flying', 'dragging');
    node.style.pointerEvents = 'none';
    setFeedback(node, dir, 1.2);
    let x = from.x, y = from.y, r = from.rot;
    const W = window.innerWidth, H = window.innerHeight;
    const axisX = dir === 'right' || dir === 'left';
    const sgn = dir === 'right' || dir === 'down' ? 1 : -1;
    const along = Math.max(Math.abs(axisX ? v.x : v.y) * 1000, 2300);
    let vx = axisX ? sgn * along : v.x * 600;
    let vy = axisX ? v.y * 600 : sgn * along;
    const vr = axisX ? sgn * 70 : (x >= 0 ? 1 : -1) * 18;
    commit(card, dir, opts.text, opts.photos);
    const finish = () => { node.remove(); el.tint.style.opacity = 0; for (const b of document.querySelectorAll('.act')) b.style.transform = ''; };
    if (reduced()) { node.style.transition = 'opacity .15s'; node.style.opacity = 0; setTimeout(finish, 160); return; }
    animate((dt) => {
      vx *= 1 + dt * 1.5; vy *= 1 + dt * 1.5;
      x += vx * dt; y += vy * dt; r += vr * dt;
      place(node, x, y, r);
      if (Math.abs(x) > W + 120 || Math.abs(y) > H + 160) { finish(); return false; }
    });
  }

  // programmatic swipe (buttons / keyboard / sheet quick answers)
  function swipe(dir, opts = {}) {
    const node = el.stack.querySelector('.card[data-depth="0"]:not(.flying)');
    const card = node && topCardData(node);
    if (!card || (card.gestures[dir] || {}).disabled || state.busy) return;
    if (card.gestures[dir].reply && !opts.fromSheet) return openSheet(card, { gesture: dir });
    flash(dir);
    if (reduced()) return flyOut(node, dir, { x: 0, y: 0, rot: 0 }, { x: 0, y: 0 }, opts);
    state.busy = true;
    node.classList.add('dragging');
    const w = node.offsetWidth, hh = node.offsetHeight;
    const tx = dir === 'right' ? w * 0.42 : dir === 'left' ? -w * 0.42 : 0;
    const ty = dir === 'down' ? hh * 0.26 : dir === 'up' ? -hh * 0.26 : 0;
    let t = 0; const T = 0.2;
    animate((dt) => {
      t = Math.min(T, t + dt); const e = 1 - Math.pow(1 - t / T, 3);
      const x = tx * e, y = ty * e, rot = (x / w) * 17;
      place(node, x, y, rot);
      setFeedback(node, dir, 1.05 * e);
      if (t >= T) {
        state.busy = false;
        flyOut(node, dir, { x, y, rot }, { x: Math.sign(tx) * 1.6, y: Math.sign(ty) * 1.6 }, opts);
        return false;
      }
    });
  }
  function flash(dir) { const b = document.querySelector(`.act[data-g="${dir}"]`); if (!b) return; b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }

  // ---------- triple tap ----------
  let tapTimer;
  function handleTap(e, node) {
    const now = performance.now();
    state.taps = state.taps.filter((t) => now - t < 700);
    state.taps.push(now);
    const r = node.getBoundingClientRect();
    if (!reduced()) { const rp = h('div', { class: 'tap-ripple', style: `left:${e.clientX - r.left}px;top:${e.clientY - r.top}px` }); node.append(rp); setTimeout(() => rp.remove(), 520); }
    const dots = node.querySelectorAll('.tap-hint .dots i');
    dots.forEach((d, i) => d.classList.toggle('on', i < state.taps.length));
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { state.taps = []; dots.forEach((d) => d.classList.remove('on')); }, 720);
    if (state.taps.length >= 3) {
      state.taps = [];
      buzz([6, 40, 6]);
      setTimeout(() => dots.forEach((d) => d.classList.remove('on')), 300);
      openSheet(topCardData(node));
    }
  }

  // ---------- sheet ----------
  // mode = which gesture Save records: 'tap3' (custom reply) or a direction flagged `reply` (e.g. "Something's off").
  function openSheet(card, { gesture = 'tap3', text = '', photos = [] } = {}) {
    if (!card) return;
    state.sheetCard = card; state.sheetOpenedAt = performance.now();
    const bot = $('#sheetBot'); bot.innerHTML = '';
    bot.append(h('div', { class: 'avatar', style: `--accent:${card.color || '#7c6cf2'}` }, card.emoji || '🤖'),
      h('div', {}, card.source, h('small', {}, card.builtin ? 'Built into Morning Deck' : fmtTime(card.createdAt) + (card.sample ? ' · SAMPLE data' : ''))));
    $('#sheetTitle').textContent = card.title;
    $('#sheetBody').textContent = card.body || '';
    $('#sheetDetails').textContent = card.details || '';
    el.sheetScroll.scrollTop = 0;
    el.reply.value = text;
    clearPhotos();
    for (const p of photos) addPhotoEntry(p);
    setSheetMode(gesture);
    el.sheetWrap.classList.remove('closing', 'kb'); el.sheetWrap.hidden = false;
    syncViewport();
    // No auto-focus: the keyboard only opens when the text box is tapped.
  }
  function setSheetMode(gesture) {
    const card = state.sheetCard; if (!card) return;
    state.sheetGesture = card.gestures[gesture] ? gesture : 'tap3';
    const g = card.gestures[state.sheetGesture];
    const quick = $('#sheetQuick'); quick.innerHTML = '';
    for (const d of DIRS) {
      const qg = card.gestures[d]; if (!qg || qg.disabled) continue;
      const on = state.sheetGesture === d;
      const b = h('button', { type: 'button', class: `qbtn${on ? ' on' : ''}`, style: `--c:${COLORS[d]}`, 'aria-pressed': qg.reply ? String(on) : null }, `${{ right: '→', left: '←', up: '↑', down: '↓' }[d]}  ${qg.label}`);
      b.addEventListener('click', () => {
        if (qg.reply) return setSheetMode(on ? 'tap3' : d); // toggle "explain" mode in place
        closeSheet(); setTimeout(() => swipe(d), 260);
      });
      quick.append(b);
    }
    $('#replyLabel').textContent = g.prompt || (state.sheetGesture === 'tap3' ? 'Your reply' : `${g.label}: add a note`);
    el.reply.placeholder = state.sheetGesture === 'tap3' ? (card.builtin ? 'Ideas, bugs, wishes… or just add a photo' : 'Type your answer…') : 'Optional: what happened?';
    el.sheetWrap.dataset.mode = state.sheetGesture;
    el.sheetWrap.style.setProperty('--mode-c', COLORS[state.sheetGesture]);
    updateSave();
  }
  function closeSheet() {
    if (!state.sheetCard) return;
    state.sheetCard = null;
    el.reply.blur();
    const done = () => { if (state.sheetCard) return; /* reopened meanwhile */ el.sheetWrap.hidden = true; el.sheetWrap.classList.remove('closing', 'kb'); state.sheetGesture = 'tap3'; clearPhotos(); };
    if (reduced()) return done();
    el.sheetWrap.classList.add('closing');
    setTimeout(done, 280);
  }
  function updateSave() {
    const card = state.sheetCard;
    const busy = state.photos.some((p) => p.status === 'processing');
    const ready = state.photos.filter((p) => p.status === 'ready').length;
    const hasText = !!el.reply.value.trim();
    const g = card && card.gestures[state.sheetGesture];
    const allowEmpty = state.sheetGesture !== 'tap3';
    el.save.disabled = !card || busy || !(hasText || ready || allowEmpty);
    el.save.textContent = busy ? 'Preparing photos…' : g && state.sheetGesture !== 'tap3' ? `Save · ${g.label}` : card && card.builtin ? 'Save suggestion' : 'Save reply';
    const n = state.photos.length;
    el.photoBtnLabel.textContent = n ? `${n}/${MAX_PHOTOS}` : 'Add photo';
    el.photoBtn.classList.toggle('compact', n > 0);
    el.photoBtn.disabled = n >= MAX_PHOTOS;
  }
  function saveReply() {
    const card = state.sheetCard; const text = el.reply.value.trim();
    if (!card || el.save.disabled) return;
    const gesture = state.sheetGesture;
    const photos = state.photos.filter((p) => p.status === 'ready').map(({ clientUploadId, blob, mime, width, height, name }) => ({ clientUploadId, blob, mime, width, height, name }));
    state.photos = []; // hand blobs to the answer; closeSheet() won't revoke them now
    closeSheet();
    if (gesture !== 'tap3') { setTimeout(() => swipe(gesture, { fromSheet: true, text, photos }), 260); return; }
    const node = el.stack.querySelector(`.card[data-id="${CSS.escape(card.id)}"]`);
    if (!node) return commit(card, 'tap3', text, photos);
    node.classList.add('flying');
    node.style.pointerEvents = 'none';
    const stamp = node.querySelector('.stamp-tap3'); stamp.style.opacity = 1; stamp.style.setProperty('--s', 1);
    const ring = node.querySelector('.card-ring'); ring.style.setProperty('--glow', rgba(COLORS.tap3, 0.9)); ring.style.opacity = 1;
    node.style.boxShadow = `0 0 60px ${rgba(COLORS.tap3, 0.6)}`;
    commit(card, 'tap3', text, photos);
    if (reduced()) { node.remove(); return; }
    node.style.transition = 'transform .55s cubic-bezier(.5,-0.4,.7,.4), opacity .5s ease-in';
    setTimeout(() => { node.style.transform = 'translate3d(0,-120%,0) scale(.7) rotate(-6deg)'; node.style.opacity = 0; }, 260);
    setTimeout(() => node.remove(), 900);
  }

  // ---------- photos (client-side downscale -> WebP/JPEG ~0.85, long side <= 1600px) ----------
  let encodeType;
  function bestType() {
    if (encodeType) return encodeType;
    try { const c = document.createElement('canvas'); c.width = c.height = 2; encodeType = c.toDataURL('image/webp', 0.8).startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg'; }
    catch { encodeType = 'image/jpeg'; }
    return encodeType;
  }
  async function decode(file) {
    if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {} }
    return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 0); }; img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode failed')); }; img.src = url; });
  }
  async function downscale(file) {
    let src;
    try { src = await decode(file); }
    catch (e) {
      // Can't decode here (e.g. HEIC): send the original if it's small enough; the server checks it's a real image.
      if (file.size <= MAX_UPLOAD && /^image\//.test(file.type)) return { blob: file, mime: file.type, width: null, height: null, original: true };
      throw new Error('this photo format can’t be read here');
    }
    const w = src.width || src.naturalWidth, hh = src.height || src.naturalHeight;
    const k = Math.min(1, MAX_EDGE / Math.max(w, hh));
    const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(hh * k));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const type = bestType();
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, W, H);
    if (src.close) src.close();
    const blob = await new Promise((res) => cv.toBlob(res, type, PHOTO_QUALITY));
    cv.width = cv.height = 0;
    if (!blob) throw new Error('couldn’t compress photo');
    if (blob.size > MAX_UPLOAD) throw new Error('photo is still over 8 MB');
    return { blob, mime: blob.type || type, width: W, height: H };
  }
  function addPhotoEntry(p) {
    const entry = { key: uid(), clientUploadId: p.clientUploadId || uid(), status: p.blob ? 'ready' : 'processing', ...p };
    if (entry.blob) entry.url = URL.createObjectURL(entry.blob);
    state.photos.push(entry);
    const close = h('button', { type: 'button', class: 'thumb-x', 'aria-label': 'Remove photo' }, h('span', { 'aria-hidden': 'true' }, '×'));
    const node = h('div', { class: `thumb${entry.status === 'processing' ? ' loading' : ''}`, 'data-key': entry.key }, close);
    if (entry.url) node.style.backgroundImage = `url("${entry.url}")`;
    close.addEventListener('click', (e) => { e.stopPropagation(); removePhoto(entry.key); });
    el.thumbs.append(node);
    requestAnimationFrame(() => { el.thumbs.scrollLeft = el.thumbs.scrollWidth; });
    updateSave();
    return entry;
  }
  function removePhoto(key) {
    const i = state.photos.findIndex((p) => p.key === key); if (i < 0) return;
    const [p] = state.photos.splice(i, 1);
    const node = el.thumbs.querySelector(`[data-key="${key}"]`);
    if (node) { node.classList.add('leaving'); setTimeout(() => node.remove(), reduced() ? 0 : 220); }
    if (p.url) setTimeout(() => URL.revokeObjectURL(p.url), 400);
    buzz(6); updateSave();
  }
  function clearPhotos() {
    for (const p of state.photos) if (p.url) URL.revokeObjectURL(p.url);
    state.photos = []; el.thumbs.innerHTML = ''; el.photoInput.value = ''; updateSave();
  }
  async function onPhotosPicked() {
    const files = [...el.photoInput.files]; el.photoInput.value = '';
    if (!files.length || !state.sheetCard) return;
    const room = MAX_PHOTOS - state.photos.length;
    if (files.length > room) toast(`Up to ${MAX_PHOTOS} photos per reply · added ${Math.max(0, room)}`, COLORS.up, 2600);
    const card = state.sheetCard;
    await Promise.all(files.slice(0, Math.max(0, room)).map(async (file) => {
      const entry = addPhotoEntry({ name: file.name });
      try {
        const out = await downscale(file);
        if (state.sheetCard !== card || !state.photos.includes(entry)) return;
        Object.assign(entry, out, { status: 'ready', url: URL.createObjectURL(out.blob) });
        const node = el.thumbs.querySelector(`[data-key="${entry.key}"]`);
        if (node) { node.classList.remove('loading'); node.style.backgroundImage = `url("${entry.url}")`; node.classList.add('ready'); }
      } catch (e) {
        toast(`Couldn’t add ${file.name || 'photo'}: ${e.message}`, COLORS.left, 3200);
        removePhoto(entry.key);
      }
      updateSave();
    }));
  }

  // ---------- keyboard / visual viewport ----------
  // Pin the sheet to the *visible* area: with interactive-widget=resizes-content the layout viewport shrinks for the
  // keyboard; on browsers that overlay it instead, bottom offset = innerHeight - visualViewport.height - offsetTop.
  const vv = window.visualViewport;
  const tallest = {};
  function syncViewport() {
    const ih = window.innerHeight, vh = vv ? vv.height : ih, top = vv ? vv.offsetTop : 0;
    const kb = Math.max(0, Math.round(ih - vh - top));
    const wkey = Math.round(window.innerWidth);
    tallest[wkey] = Math.max(tallest[wkey] || 0, vh + kb);
    const rs = document.documentElement.style;
    rs.setProperty('--vvh', `${Math.round(vh)}px`); rs.setProperty('--kb', `${kb}px`);
    const typing = document.activeElement === el.reply;
    const kbOpen = !!state.sheetCard && (kb > 60 || (typing && vh < tallest[wkey] * 0.8));
    el.sheetWrap.classList.toggle('kb', kbOpen);
    if (kbOpen && typing) keepInputVisible();
  }
  let keepRaf;
  function keepInputVisible() {
    cancelAnimationFrame(keepRaf);
    keepRaf = requestAnimationFrame(() => { try { el.reply.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {} });
  }
  if (vv) { vv.addEventListener('resize', syncViewport); vv.addEventListener('scroll', syncViewport); }
  window.addEventListener('resize', syncViewport);
  el.reply.addEventListener('focus', () => { syncViewport(); keepInputVisible(); [120, 320, 650].forEach((t) => setTimeout(() => { syncViewport(); keepInputVisible(); }, t)); });
  el.reply.addEventListener('blur', () => setTimeout(syncViewport, 60));

  // ---------- commit / undo ----------
  function commit(card, gesture, text, photos = []) {
    const idx = state.deck.findIndex((c) => c.id === card.id);
    if (idx < 0) return;
    state.deck.splice(idx, 1);
    const g = card.gestures[gesture] || {};
    const payload = { cardId: card.id, gesture, value: g.value, answeredAt: new Date().toISOString(), clientAnswerId: uid() };
    if (text) payload.text = text;
    const entry = { card, gesture, payload, photos, answerId: null, queued: false };
    state.history.push(entry); state.session.push(entry);
    buzz(12);
    const pics = photos.length ? ` · ${photos.length} photo${photos.length > 1 ? 's' : ''}` : '';
    const label = gesture === 'tap3' ? (card.builtin ? 'Thanks! Suggestion saved' : 'Reply saved') : card.builtin && gesture === 'right' ? 'Love it · thanks!' : g.label;
    toast(`${label}${card.builtin ? '' : ` · ${card.source}`}${pics}${gesture === 'up' ? ' · back tomorrow 6 AM' : ''}`, COLORS[gesture]);
    entry.promise = (photos.length ? sendAnswer(payload, photos) : api('/api/answers', { method: 'POST', body: JSON.stringify(payload) }))
      .then((r) => { entry.answerId = r.answer.id; })
      .catch(async (e) => {
        if (e.status === 401) return;
        if (!photos.length) {
          if (transient(e)) { entry.queued = true; setOutbox([...outbox(), payload]); setStatus('Offline · answers will sync when you reconnect'); }
          else toast(`Couldn't record: ${e.message}`, COLORS.left);
          return;
        }
        if (transient(e)) {
          // Keep the reply AND its photos on the phone (IndexedDB) and sync when back online.
          try {
            await idb.put({ id: payload.clientAnswerId, payload, photos, queuedAt: new Date().toISOString() });
            entry.queued = true;
            toast(`No connection · reply + ${photos.length} photo${photos.length > 1 ? 's' : ''} saved on this phone, will sync`, COLORS.up, 3600);
            setStatus(`Offline · reply with ${photos.length} photo${photos.length > 1 ? 's' : ''} waiting to sync`);
            clearTimeout(retryTimer); retryTimer = setTimeout(flushOutbox, 15000);
            return;
          } catch (_) { /* no IndexedDB: fall through and give the reply back */ }
        }
        // Couldn't upload and couldn't queue: put the card back with the text + photos so nothing is lost.
        toast(`Couldn't upload photos: ${e.message}. Your reply is back, try again.`, COLORS.left, 4200);
        state.history = state.history.filter((x) => x !== entry); state.session = state.session.filter((x) => x !== entry);
        if (!state.deck.some((c) => c.id === card.id)) state.deck.unshift(card);
        el.cleared.hidden = true; el.app.classList.remove('is-cleared');
        render();
        if (!state.sheetCard) openSheet(card, { gesture, text: text || '', photos });
      });
    render();
    if (!state.deck.length) setTimeout(() => { if (!state.deck.length) renderCleared(true); }, 260);
  }

  async function undo() {
    const entry = state.history.pop();
    if (!entry) return;
    el.undo.disabled = true;
    try { await entry.promise; } catch (_) {}
    try {
      if (entry.queued && entry.photos.length) await idb.del(entry.payload.clientAnswerId);
      else if (entry.queued && outbox().some((p) => p.clientAnswerId === entry.payload.clientAnswerId)) setOutbox(outbox().filter((p) => p.clientAnswerId !== entry.payload.clientAnswerId));
      else if (entry.answerId) await api('/api/answers/undo', { method: 'POST', body: JSON.stringify({ answerId: entry.answerId }) });
    } catch (e) { if (e.status) { toast(`Couldn't undo: ${e.message}`, COLORS.left); render(); return; } }
    state.session = state.session.filter((x) => x !== entry);
    state.deck.unshift(entry.card);
    el.cleared.hidden = true;
    el.app.classList.remove('is-cleared');
    render();
    const node = el.stack.querySelector(`.card[data-id="${CSS.escape(entry.card.id)}"]`);
    if (node && !reduced()) {
      const W = window.innerWidth, H = window.innerHeight;
      const from = { right: [W, 0, 30], left: [-W, 0, -30], up: [0, -H, 0], down: [0, H, 0], tap3: [0, -H * 0.6, -6] }[entry.gesture];
      node.dataset.depth = '0'; node.style.setProperty('--depth', 0);
      place(node, from[0], from[1], from[2]); node.classList.add('dragging');
      springBack(node, { x: from[0], y: from[1], rot: from[2] }, { x: 0, y: 0 });
    }
    toast(`Undone · ${entry.card.source}`, COLORS.undo);
  }

  // ---------- confetti ----------
  // Short burst (~2 s): full-canvas clear every frame in device pixels (identity transform), fade over the last 400 ms,
  // then stop the loop and hide the canvas so the summary underneath is clean and tappable. Canvas is pointer-events:none.
  let confettiRun = null;
  function confetti() {
    if (reduced()) return;
    if (confettiRun) confettiRun.stop();
    const cv = $('#confetti'); const ctx = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    cv.hidden = false;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const DURATION = 2.0, FADE = 0.4;
    const palette = ['#ffd27a', '#ff8c5a', '#ff5f8f', '#19c37d', '#38b6ff', '#8b7cf6', '#ffffff'];
    const parts = [];
    const burst = (x, y, n, ang, spread, spd) => { for (let i = 0; i < n; i++) { const a = ang + (Math.random() - 0.5) * spread; const sp = spd * (0.55 + Math.random() * 0.6); parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12, w: 6 + Math.random() * 7, h: 4 + Math.random() * 6, c: palette[(Math.random() * palette.length) | 0], shape: Math.random() < 0.3 ? 'c' : 'r' }); } };
    burst(0, H * 0.75, 70, -Math.PI / 3, 0.9, 1050);
    burst(W, H * 0.75, 70, -Math.PI * 2 / 3, 0.9, 1050);
    burst(W / 2, H * 0.35, 50, -Math.PI / 2, Math.PI * 2, 560);
    const wipe = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.clearRect(0, 0, cv.width, cv.height); };
    const t0 = performance.now();
    let stopped = false, safety;
    const stop = () => {
      if (stopped) return; stopped = true;
      anim.cancel(); clearTimeout(safety); wipe();
      cv.width = 0; cv.height = 0; cv.hidden = true; // release the bitmap; nothing can linger on screen
      if (confettiRun && confettiRun.stop === stop) confettiRun = null;
    };
    const anim = animate((dt) => {
      const t = (performance.now() - t0) / 1000; // wall clock, so slow phones still finish on time
      if (t >= DURATION) { stop(); return false; }
      wipe();
      const alpha = clamp((DURATION - t) / FADE);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const p of parts) {
        p.vy += 1500 * dt; p.vx *= 1 - 0.9 * dt; p.vy *= 1 - 0.4 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
        if (p.y > H + 40) continue;
        ctx.save(); ctx.globalAlpha = alpha; ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        if (p.shape === 'c') { ctx.beginPath(); ctx.arc(0, 0, p.w / 2.4, 0, Math.PI * 2); ctx.fill(); }
        else { ctx.scale(1, Math.max(0.15, Math.abs(Math.cos(p.r * 2)))); ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
        ctx.restore();
      }
    });
    safety = setTimeout(stop, DURATION * 1000 + 500); // even if rAF is throttled (background tab), clean up
    confettiRun = { stop };
    return confettiRun;
  }

  // ---------- wiring ----------
  document.querySelectorAll('.act[data-g]').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.g;
    if (g === 'tap3') return openSheet(state.deck[0]);
    swipe(g);
  }));
  el.undo.addEventListener('click', undo);
  $('#refreshBtn').addEventListener('click', () => { state.session = []; state.history = []; loadDeck({ initial: true }); });
  $('#sheetCancel').addEventListener('click', closeSheet);
  $('#sheetBackdrop').addEventListener('click', () => { if (performance.now() - state.sheetOpenedAt > 450) closeSheet(); });
  el.reply.addEventListener('input', updateSave);
  el.photoBtn.addEventListener('click', () => { if (state.photos.length < MAX_PHOTOS) el.photoInput.click(); });
  el.photoInput.addEventListener('change', onPhotosPicked);
  el.status.addEventListener('click', () => flushOutbox().then((n) => { if (!n) toast('All synced', COLORS.right); }));
  el.save.addEventListener('click', saveReply);
  el.reply.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveReply(); });
  document.addEventListener('keydown', (e) => {
    if (state.sheetCard) { if (e.key === 'Escape') closeSheet(); return; }
    if (e.target.closest && e.target.closest('textarea,input')) return;
    const map = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down' };
    if (map[e.key]) { e.preventDefault(); swipe(map[e.key]); }
    else if (e.key === 'Enter' || e.key === 'r') { e.preventDefault(); openSheet(state.deck[0]); }
    else if (e.key === 'u' || e.key === 'Backspace' || ((e.ctrlKey || e.metaKey) && e.key === 'z')) { e.preventDefault(); undo(); }
  });
  window.addEventListener('online', flushOutbox);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.locked) return;
    flushOutbox();
    if (state.loaded && !state.deck.length) loadDeck();
  });

  greeting();
  render();
  loadConfig();
  flushOutbox().finally(() => loadDeck({ initial: true }));
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed', e)));
  window.MorningDeck = { state, swipe, openSheet, undo, flushOutbox, syncViewport, confetti }; // handy for debugging
})();
