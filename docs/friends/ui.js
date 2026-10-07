/* Morning Deck for Friends — screens on top of the shared swipe UI: landing, service picker/panel, dialogs,
 * feedback sharing, sign-in refresh, inbox polling. The wizard and Settings live in ui-setup.js. */
(() => {
  'use strict';
  const M = window.MDF; const MD = window.MorningDeck; const CFG = M.CFG; const h = M.h;
  const layer = document.getElementById('mdfLayer');
  const UI = (M.ui = {});

  // ---------- overlay stack ----------
  const stack = [];
  function overlay(cls, label, { onClose } = {}) {
    const node = h('div', { class: `mdf-overlay ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
    const entry = { node, onClose };
    entry.close = () => { const i = stack.indexOf(entry); if (i < 0) return; stack.splice(i, 1); node.classList.add('leaving'); setTimeout(() => node.remove(), 180); sync(); if (onClose) onClose(); };
    stack.push(entry); layer.append(node); sync();
    requestAnimationFrame(() => node.classList.add('shown'));
    return entry;
  }
  function sync() { if (stack.length) document.documentElement.setAttribute('data-overlay', ''); else document.documentElement.removeAttribute('data-overlay'); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stack.length && !MD.state.sheetCard) { const top = stack[stack.length - 1]; if (!top.node.dataset.sticky) top.close(); } });
  UI.overlay = overlay; UI.stack = stack;
  const closeAll = () => [...stack].reverse().forEach((x) => x.close());
  UI.closeAll = closeAll;

  const statusLine = (el) => (msg, kind = '') => { el.textContent = msg || ''; el.className = `f-status ${kind ? 'is-' + kind : ''}`; el.hidden = !msg; };
  const ago = (iso) => { if (!iso) return ''; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  UI.ago = ago;

  // ---------- mini preview card ----------
  function miniCard(c) {
    const card = M.normalize(c, c.service);
    return h('div', { class: 'mdf-mini', style: `--accent:${card.color || '#7c6cf2'}` },
      h('div', { class: 'mdf-mini-head' }, h('span', { class: 'mdf-mini-emoji' }, card.emoji || '🤖'), h('b', null, card.source), card.chip ? h('span', { class: 'chip' }, card.chip) : null, h('span', { class: `chip prio-${card.priority}` }, card.priority === 'high' ? 'High' : card.priority === 'low' ? 'Low' : 'Normal')),
      h('div', { class: 'mdf-mini-title' }, card.title), card.body ? h('div', { class: 'mdf-mini-body' }, card.body) : null,
      h('div', { class: 'mdf-mini-g' }, `→ ${card.gestures.right.label} · ← ${card.gestures.left.label} · ↑ ${card.gestures.up.label}`));
  }
  UI.miniCard = miniCard;

  // ---------- landing ----------
  function showLanding() {
    const o = overlay('mdf-landing', 'Welcome to Morning Deck'); o.node.dataset.sticky = '1';
    const done = (wizard) => { M.ls.set('seen', true); o.close(); if (wizard) UI.openWizard(); };
    o.node.append(h('div', { class: 'mdf-landing-inner' },
      h('img', { class: 'mdf-hero-icon', src: 'icons/icon-192.png', alt: '', width: 88, height: 88 }),
      h('h1', null, 'Your day, one swipe at a time'),
      h('p', { class: 'mdf-lede' }, 'Each morning, Morning Deck turns your weather, calendar, tasks, mail, headlines and your own automations into a short deck of cards. Swipe each one: done, not now, later.'),
      h('ul', { class: 'mdf-points' },
        h('li', null, h('span', null, '🔒'), h('div', null, h('b', null, 'Private. '), 'Everything stays on this phone. There’s no account and no server, and nobody else sees your data.')),
        h('li', null, h('span', null, '🆓'), h('div', null, h('b', null, 'Free. '), 'It runs in your browser and installs like an app.')),
        h('li', null, h('span', null, '🛟'), h('div', null, h('b', null, 'Safe. '), 'Swipes only record your answer. Only if you allow it can they take small, undoable actions, like completing a task.'))),
      h('div', { class: 'mdf-cta' },
        h('button', { type: 'button', class: 'primary-btn mdf-big', id: 'landingTry', onclick: () => done(false) }, 'Try it with sample cards'),
        h('button', { type: 'button', class: 'ghost-btn mdf-big', id: 'landingMine', onclick: () => done(true) }, 'Make it mine')),
      h('p', { class: 'mdf-fine' }, 'Gestures: swipe right or left to answer, up for later, down to skip, triple-tap to add a note. ', h('a', { href: 'https://github.com/watsdr/morning-deck', target: '_blank', rel: 'noopener' }, 'Open source'), ' · MIT')));
  }

  // ---------- service picker ----------
  const ORDER = ['Everyday', 'Calendar', 'Tasks', 'Email', 'Work & code', 'Automations', 'Coming soon'];
  function badge(def) {
    const st = M.svcState(def.id);
    if (def.status === 'soon') return ['Soon', 'b-soon'];
    if (st) return [st.error && !st.needsSetup ? '⚠ Check' : '✓ Added', st.error && !st.needsSetup ? 'b-warn' : 'b-on'];
    if (def.oauth) return def.needsSetup() ? ['Needs setup', 'b-setup'] : ['Sign in', 'b-free'];
    return ['Free', 'b-free'];
  }
  function renderPicker(container, { onChange } = {}) {
    container.innerHTML = '';
    const groups = {}; for (const d of M.services.values()) (groups[d.category] = groups[d.category] || []).push(d);
    for (const cat of ORDER) {
      if (!groups[cat]) continue;
      container.append(h('div', { class: 'mdf-cat' }, cat));
      const grid = h('div', { class: 'mdf-grid' });
      for (const d of groups[cat]) {
        const [b, bc] = badge(d);
        grid.append(h('button', { type: 'button', class: `mdf-tile ${d.status === 'soon' ? 'is-soon' : ''} ${M.svcState(d.id) ? 'is-on' : ''}`, 'data-svc': d.id, style: `--accent:${d.color}`, onclick: () => openService(d.id, { onDone: () => { renderPicker(container, { onChange }); if (onChange) onChange(); } }) },
          h('span', { class: 'mdf-tile-emoji', 'aria-hidden': 'true' }, d.emoji), h('span', { class: 'mdf-tile-name' }, d.name), h('span', { class: `mdf-badge ${bc}` }, b)));
      }
      container.append(grid);
    }
    M.svcKit.google.preload(); M.svcKit.ms.preload();
  }
  UI.renderPicker = renderPicker;
  function openPicker({ onDone } = {}) {
    const o = overlay('mdf-sheetish', 'Add a service', { onClose: onDone });
    const body = h('div', { class: 'mdf-scroll' });
    o.node.append(h('header', { class: 'mdf-head' }, h('button', { type: 'button', class: 'mdf-back', 'aria-label': 'Back', onclick: o.close }, '‹'), h('h2', null, 'Add a service')), body);
    body.append(h('p', { class: 'mdf-lede' }, 'Pick what goes into your deck. Each one connects straight from this phone to the service.'));
    const grid = h('div'); body.append(grid); renderPicker(grid);
  }
  UI.openPicker = openPicker;

  // ---------- one service: connect · test · preview · save ----------
  function openService(id, { onDone } = {}) {
    const def = M.services.get(id); const existing = M.svcState(id);
    const o = overlay('mdf-sheetish mdf-service', def.name, { onClose: onDone });
    o.node.dataset.svc = id;
    const body = h('div', { class: 'mdf-scroll' });
    o.node.append(h('header', { class: 'mdf-head', style: `--accent:${def.color}` }, h('button', { type: 'button', class: 'mdf-back', 'aria-label': 'Back', onclick: o.close }, '‹'), h('span', { class: 'mdf-head-emoji' }, def.emoji), h('h2', null, def.name)), body);
    if (def.blurb) body.append(h('p', { class: 'mdf-lede' }, def.blurb));
    if (def.status === 'soon') {
      body.append(h('div', { class: 'mdf-soon' }, h('b', null, 'Coming soon. '), def.reason), h('button', { type: 'button', class: 'primary-btn mdf-big', onclick: o.close }, 'OK'));
      return o;
    }
    if (def.privacy) body.append(h('p', { class: 'mdf-privacy' }, '🔒 ', def.privacy));
    if (def.oauth && def.needsSetup()) {
      const who = def.provider === 'google' ? 'Google' : 'Microsoft';
      const ask = `Could you set up ${who} sign-in for Morning Deck? It’s a one-time setup (about 10 minutes): https://github.com/watsdr/morning-deck/blob/main/docs/FRIENDS-OWNER-SETUP.md`;
      body.append(h('div', { class: 'mdf-setup' }, h('b', null, 'Needs setup. '), `The person who shared this app hasn’t switched on ${who} sign-in yet. ${who} requires each app to be registered once, and that’s free. Meanwhile, these work right now: Calendar link (ICS), Todoist, Universal inbox.`),
        h('div', { class: 'f-row' },
          h('button', { type: 'button', class: 'f-btn', onclick: () => shareText(`${who} sign-in for Morning Deck`, ask) }, 'Ask them to set it up'),
          h('button', { type: 'button', class: 'f-btn f-btn-soft', onclick: o.close }, 'Back')));
      return o;
    }
    let cfg = { ...(def.defaults ? def.defaults() : {}), ...((existing && existing.cfg) || {}) };
    let act = !!(existing && existing.act);
    const statusEl = h('p', { class: 'f-status', role: 'status', hidden: true }); const status = statusLine(statusEl);
    const preview = h('div', { class: 'mdf-preview', 'aria-live': 'polite' });
    const kit = { h, getCfg: () => cfg, setCfg: (p) => { cfg = { ...cfg, ...p }; }, status, testNow: () => runTest(), preview: () => runTest() };
    const setup = h('div', { class: 'mdf-setupbox' }); body.append(setup);

    if (def.oauth) {
      const who = def.provider === 'google' ? 'Google' : 'Microsoft';
      setup.append(h('button', { type: 'button', class: `mdf-signin mdf-signin-${def.provider}`, 'data-act': 'signin', onclick: async () => {
        status(`Opening ${who}…`);
        try { await def.connect(); status(`Signed in to ${who} ✓`, 'ok'); runTest(); } catch (e) { status(e.message, 'err'); }
      } }, def.provider === 'google' ? h('span', { class: 'g-logo', 'aria-hidden': 'true' }, 'G') : h('span', { class: 'ms-logo', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')), `Sign in with ${who}`),
      h('p', { class: 'f-note' }, `${who} will ask you to allow read-only access. Your sign-in stays in this browser.`));
    }
    for (const f of def.fields || []) {
      const input = h('input', { class: 'f-input', type: f.type === 'password' ? 'password' : 'text', placeholder: f.placeholder || '', value: cfg[f.key] || '', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': f.label, 'data-field': f.key, oninput: (e) => { cfg[f.key] = e.target.value.trim(); } });
      const wrap = h('label', { class: 'f-label' }, f.label, h('div', { class: 'f-row' }, input, f.type === 'password' ? h('button', { type: 'button', class: 'f-btn f-btn-soft f-eye', 'aria-label': 'Show or hide', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } }, '👁') : null));
      setup.append(wrap);
      if (f.help) setup.append(h('p', { class: 'f-note' }, f.help, ' ', f.link ? h('a', { href: f.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open ↗') : null));
    }
    if (def.renderSetup) def.renderSetup(setup, cfg, kit);

    async function runTest() {
      const err = def.validate ? def.validate(cfg) : '';
      if (err) { status(err, 'err'); return false; }
      status('Testing…'); preview.innerHTML = '';
      try {
        const ctx = M.ctx(id);
        const cards = await Promise.race([(def.test || def.fetch).call(def, cfg, ctx), new Promise((_, rej) => setTimeout(() => rej(new M.FriendlyError(`${def.name} took too long to answer`)), 15000))]);
        const list = (cards || []).slice(0, 3);
        const meta = M.pendingMeta[id] || {}; const st = M.svcState(id) || {};
        const acct = meta.account || st.account;
        status(`Works ✓${acct ? ` · ${acct}` : ''}${(cards || []).length ? ` · ${(cards || []).length} card${cards.length > 1 ? 's' : ''} today` : ' · nothing for today right now'}${meta.warn || st.warn ? ` · ${meta.warn || st.warn}` : ''}`, 'ok');
        if (list.length) { preview.append(h('div', { class: 'mdf-sub' }, 'Preview'), ...list.map(miniCard)); }
        else preview.append(h('p', { class: 'f-note' }, 'No cards for today right now. That’s fine: cards appear when there’s something to show.'));
        return true;
      } catch (e) { status(e.message || String(e), 'err'); return false; }
    }
    if (!def.noTest) setup.append(h('button', { type: 'button', class: 'f-btn mdf-test', 'data-act': 'test', onclick: runTest }, def.oauth ? 'Test & preview' : 'Test & preview'));
    body.append(statusEl, preview);

    if (def.canAct) {
      const tog = h('input', { type: 'checkbox', role: 'switch', checked: act, 'data-act': 'act-toggle', onchange: async (e) => {
        if (e.target.checked && def.oauth) {
          status('Asking for permission to act…');
          try { await def.enableAct(); act = true; status('Swipes can now act (with Undo) ✓', 'ok'); } catch (err) { e.target.checked = false; act = false; status(err.message, 'err'); }
        } else { act = e.target.checked; status(act ? 'Swipes will act (reversible, with Undo).' : 'Swipes only record on this phone.', 'ok'); }
      } });
      body.append(h('div', { class: 'mdf-act' }, h('label', { class: 'mdf-switch' }, tog, h('span', { class: 'mdf-switch-ui', 'aria-hidden': 'true' }), h('b', null, 'Let swipes act')), h('p', { class: 'f-note' }, def.actHelp || '', ' Off by default. Morning Deck never sends messages, deletes or buys anything.')));
    } else body.append(h('p', { class: 'f-note mdf-recordonly' }, '🛟 ', def.actHelp || 'Swipes only record your answer on this phone.'));

    const save = async () => {
      const err = def.validate ? def.validate(cfg) : '';
      if (err) { status(err, 'err'); return; }
      const meta = M.pendingMeta[id] || {}; delete M.pendingMeta[id];
      M.updateService(id, { on: true, cfg, act, addedAt: (existing && existing.addedAt) || new Date().toISOString(), error: '', needsAuth: false, needsSecret: false, ...meta });
      const c = M.cacheAll(); delete c[id]; M.ls.set('cache', c);
      MD.toast(`${def.emoji} ${def.name} ${existing ? 'saved' : 'added'}`, '#19c37d');
      o.close();
      if (M.settings().setupDone) MD.loadDeck();
    };
    body.append(h('div', { class: 'mdf-actions' },
      h('button', { type: 'button', class: 'primary-btn mdf-big', 'data-act': 'save', onclick: save }, existing ? 'Save' : 'Add to my deck'),
      existing ? h('button', { type: 'button', class: 'ghost-btn mdf-danger', 'data-act': 'remove', onclick: () => {
        if (!confirm(`Remove ${def.name} from your deck? Its settings${def.fields ? ' and token' : ''} are deleted from this phone.`)) return;
        M.removeService(id); if (def.provider === 'google' && !M.svcKit.google.neededScopes().length) M.svcKit.google.signOut();
        if (def.provider === 'microsoft' && ![...M.services.values()].some((d) => d.provider === 'microsoft' && M.svcState(d.id))) M.svcKit.ms.signOut();
        MD.toast(`${def.name} removed`, '#ff4f6d'); o.close(); if (M.settings().setupDone) MD.loadDeck();
      } }, 'Remove') : null));
    return o;
  }
  UI.openService = openService;

  // ---------- small dialogs ----------
  function dialog(title, bodyNodes, buttons) {
    const o = overlay('mdf-dialog', title);
    const box = h('div', { class: 'mdf-dialog-box' }, h('h3', null, title), ...bodyNodes, h('div', { class: 'mdf-dialog-btns' }, ...buttons.map((b) => h('button', { type: 'button', class: b.primary ? 'primary-btn' : 'ghost-btn', 'data-act': b.act || null, onclick: async () => { const keep = b.onClick && (await b.onClick(o)); if (!keep) o.close(); } }, b.label))));
    o.node.append(h('div', { class: 'mdf-dialog-backdrop', onclick: o.close }), box);
    return o;
  }
  UI.dialog = dialog;
  async function shareText(title, text, files) {
    try {
      if (navigator.share) {
        const data = { title, text }; if (files && files.length && navigator.canShare && navigator.canShare({ files })) data.files = files;
        await navigator.share(data); return 'shared';
      }
    } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    try { await navigator.clipboard.writeText(text); MD.toast('Copied. Paste it into a message', '#38b6ff', 2600); return 'copied'; } catch (_) { MD.toast('Couldn’t share or copy on this browser', '#ff4f6d'); return 'failed'; }
  }
  UI.shareText = shareText;

  // ---------- feedback (improvement card) ----------
  window.addEventListener('mdf:feedback', async (ev) => {
    const { answer } = ev.detail || {}; if (!answer) return;
    const who = CFG.ownerName || 'the person who shared this app';
    const txt = answer.gesture === 'right' ? 'Morning Deck: I love it! 💛' : answer.gesture === 'left' ? `Morning Deck: something’s off${answer.text ? `:\n${answer.text}` : '.'}` : `Morning Deck idea:\n${answer.text || '(no text)'}`;
    const full = `${txt}\n\n(Sent from Morning Deck for Friends · ${new Date().toLocaleDateString()})`;
    const photos = await M.photoBlobs(answer.attachments);
    const files = photos.map((p, i) => new File([p.blob], `morning-deck-${i + 1}.${(p.mime || 'image/jpeg').split('/')[1] || 'jpg'}`, { type: p.mime || 'image/jpeg' }));
    const list = M.ls.get('feedback', []); list.push({ at: new Date().toISOString(), gesture: answer.gesture, text: answer.text || '', photos: photos.length }); M.ls.set('feedback', list.slice(-50));
    setTimeout(() => dialog(`Share it with ${who}?`, [
      h('p', { class: 'f-note' }, 'It’s saved on this phone. Sharing is up to you; nothing is sent automatically.'),
      h('pre', { class: 'mdf-quote' }, txt), photos.length ? h('p', { class: 'f-note' }, `📷 ${photos.length} photo${photos.length > 1 ? 's' : ''} attached`) : null,
    ].filter(Boolean), [
      { label: 'Share…', primary: true, act: 'fb-share', onClick: () => shareText('Morning Deck feedback', full, files) },
      { label: 'Email', act: 'fb-email', onClick: () => { location.href = `mailto:${encodeURIComponent(CFG.feedbackEmail || '')}?subject=${encodeURIComponent('Morning Deck feedback')}&body=${encodeURIComponent(full)}`; } },
      { label: 'Not now', act: 'fb-close' },
    ]), 900);
  });

  // ---------- sign-in refresh (Google tokens last 1h; Microsoft about a day) ----------
  window.addEventListener('mdf:reauth', (ev) => {
    const p = (ev.detail || {}).provider; const who = p === 'google' ? 'Google' : 'Microsoft';
    dialog(`Refresh ${who}`, [h('p', { class: 'f-note' }, `${who} needs a quick tap to confirm it’s you. If you’ve already allowed Morning Deck, the window closes by itself.`)], [
      { label: `Refresh ${who}`, primary: true, act: 'reauth-go', onClick: async (o) => {
        try { await (p === 'google' ? M.svcKit.google.signIn([]) : M.svcKit.ms.signIn([])); }
        catch (e) { MD.toast(e.message, '#ff4f6d', 4000); return true; }
        const ids = [...M.services.values()].filter((d) => d.provider === p && M.svcState(d.id)).map((d) => d.id);
        await Promise.all(ids.map((id) => M.syncService(id, { force: true })));
        MD.toast(`${who} refreshed ✓`, '#19c37d'); MD.loadDeck(); return false;
      } },
      { label: 'Not now' },
    ]);
  });
  window.addEventListener('mdf:toast', (ev) => { const d = ev.detail || {}; MD.toast(d.msg, d.color || '#fff', d.ms || 2200); });

  // ---------- footer text + polling ----------
  function footer() {
    const s = M.settings(); const acting = Object.entries(s.services).filter(([, v]) => v.act && v.on !== false).map(([id]) => (M.services.get(id) || {}).name).filter(Boolean);
    document.getElementById('safetyText').textContent = !s.setupDone ? 'Sample deck: nothing is saved. Everything stays on this phone.'
      : acting.length ? `Everything stays on this phone. Swipes can act in: ${acting.join(', ')} (undoable).` : 'Everything stays on this phone. Swipes only record your answer.';
  }
  UI.footer = footer; window.addEventListener('mdf:settings', footer); footer();
  let loadedDay = M.deckDay();
  async function pollInbox() {
    const s = M.settings(); const st = s.services.inbox;
    if (!s.setupDone || !st || st.on === false || document.hidden || MD.state.busy || MD.state.sheetCard || stack.length) return;
    await M.syncService('inbox', { force: true });
    const n = (M.svcState('inbox') || {}).newCount || 0;
    if (n > 0) { M.updateService('inbox', { newCount: 0 }); MD.toast(`📥 ${n} new card${n > 1 ? 's' : ''}`, '#18bcf2'); MD.loadDeck(); }
  }
  setInterval(pollInbox, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (M.deckDay() !== loadedDay) { loadedDay = M.deckDay(); MD.state.session = []; MD.state.history = []; MD.loadConfig(); MD.loadDeck({ initial: true }); }
  });

  document.getElementById('settingsBtn').addEventListener('click', () => UI.openSettings());
  document.getElementById('makeMineBtn').addEventListener('click', () => UI.openWizard());
  UI.showLanding = showLanding;
  // first open: landing (once), then the sample deck
  window.addEventListener('load', () => { if (!M.settings().setupDone && !M.ls.get('seen', false)) showLanding(); });
})();
