/* Morning Deck for Friends — “Make it mine” wizard and Settings (services, export/import, reset, privacy). */
(() => {
  'use strict';
  const M = window.MDF; const MD = window.MorningDeck; const UI = M.ui; const h = M.h;

  const GESTURE_HELP = [['→', 'Swipe right', null, 'right'], ['←', 'Swipe left', null, 'left'], ['↑', 'Swipe up', 'Later: back at your next deck time'], ['↓', 'Swipe down', 'Skip'], ['✋', 'Triple-tap', 'Add a note or photo (kept on this phone)']];
  function gestureEditor(draft, onChange) {
    const box = h('div', { class: 'mdf-gestures' });
    const custom = h('div', { class: 'f-row mdf-custom', hidden: draft.gestures.preset !== 'custom' });
    const rIn = h('input', { class: 'f-input', maxlength: 18, value: draft.gestures.right, 'aria-label': 'Right swipe means', oninput: (e) => { draft.gestures.right = e.target.value.trim() || 'Yes'; draw(); onChange(); } });
    const lIn = h('input', { class: 'f-input', maxlength: 18, value: draft.gestures.left, 'aria-label': 'Left swipe means', oninput: (e) => { draft.gestures.left = e.target.value.trim() || 'No'; draw(); onChange(); } });
    custom.append(rIn, lIn);
    const radios = h('div', { class: 'mdf-presets', role: 'radiogroup', 'aria-label': 'Swipe meanings' });
    for (const [k, p] of [...Object.entries(M.PRESETS), ['custom', { name: 'My own words' }]]) {
      radios.append(h('label', { class: 'mdf-preset' }, h('input', { type: 'radio', name: 'gpreset', value: k, checked: draft.gestures.preset === k, onchange: () => {
        draft.gestures.preset = k; if (k !== 'custom') { draft.gestures.right = p.right; draft.gestures.left = p.left; rIn.value = p.right; lIn.value = p.left; }
        custom.hidden = k !== 'custom'; draw(); onChange();
      } }), h('span', null, p.name)));
    }
    const table = h('ul', { class: 'mdf-gtable' });
    const draw = () => { table.innerHTML = ''; for (const [ico, name, fixed, key] of GESTURE_HELP) table.append(h('li', null, h('span', { class: 'mdf-gico' }, ico), h('b', null, name), h('span', null, fixed || (key === 'right' ? draft.gestures.right : draft.gestures.left)))); };
    draw();
    box.append(radios, custom, table, h('p', { class: 'f-note' }, 'These words are for your reminders and inbox cards. Service cards bring their own, like “Done” for tasks or “Archive” for mail.'));
    return box;
  }
  const draftFrom = (s) => ({ name: s.name || '', deckTime: s.deckTime || '07:00', gestures: { ...s.gestures } });
  const applyDraft = (d) => { const s = M.settings(); s.name = d.name.trim().slice(0, 40); s.deckTime = d.deckTime || '07:00'; s.gestures = { ...d.gestures }; M.saveSettings(s); return s; };

  // ---------- wizard ----------
  UI.openWizard = function openWizard() {
    const s0 = M.settings(); const draft = draftFrom(s0);
    const o = UI.overlay('mdf-wizard', 'Make it mine'); o.node.dataset.sticky = '1';
    const steps = ['name', 'time', 'gestures', 'services', 'done'];
    let i = 0;
    const dots = h('div', { class: 'mdf-dots', 'aria-hidden': 'true' });
    const body = h('div', { class: 'mdf-scroll' });
    const back = h('button', { type: 'button', class: 'ghost-btn', 'data-act': 'wiz-back' }, 'Back');
    const next = h('button', { type: 'button', class: 'primary-btn', 'data-act': 'wiz-next' }, 'Next');
    o.node.append(h('header', { class: 'mdf-head' }, h('button', { type: 'button', class: 'mdf-back', 'aria-label': 'Close', onclick: () => { applyDraft(draft); o.close(); } }, '✕'), h('h2', null, 'Make it mine'), dots), body, h('footer', { class: 'mdf-wizfoot' }, back, next));
    const count = () => Object.keys(M.settings().services).length;
    function render() {
      dots.innerHTML = ''; steps.forEach((_, k) => dots.append(h('i', { class: k === i ? 'on' : k < i ? 'done' : '' })));
      body.innerHTML = ''; body.scrollTop = 0; o.node.dataset.step = steps[i];
      back.hidden = i === 0; next.textContent = i === steps.length - 1 ? 'Show my deck' : steps[i] === 'services' ? (count() ? `Next (${count()} added)` : 'Skip for now') : 'Next';
      const st = steps[i];
      if (st === 'name') {
        const inp = h('input', { class: 'f-input mdf-bigin', id: 'wizName', maxlength: 40, placeholder: 'Your first name (optional)', value: draft.name, autocomplete: 'given-name', oninput: (e) => { draft.name = e.target.value; prev.textContent = greet(); } });
        const greet = () => `${new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening'}${draft.name.trim() ? `, ${draft.name.trim()}` : ''}`;
        const prev = h('p', { class: 'mdf-greetprev' }, greet());
        body.append(h('h3', null, 'What should we call you?'), h('p', { class: 'f-note' }, 'Used for the greeting only. It stays on this phone.'), inp, prev);
        setTimeout(() => inp.focus({ preventScroll: true }), 250);
      } else if (st === 'time') {
        const t = h('input', { class: 'f-input mdf-bigin', type: 'time', id: 'wizTime', value: draft.deckTime, oninput: (e) => { draft.deckTime = e.target.value || '07:00'; } });
        body.append(h('h3', null, 'When is your deck ready?'), h('p', { class: 'f-note' }, 'Your new day starts at this time: fresh cards, and anything you swiped up (“Later”) comes back.'), t,
          h('p', { class: 'f-note' }, 'Tip: install Morning Deck to your home screen and open it with your morning coffee. Web apps can’t wake your phone with alarms, so there are no notifications yet.'));
      } else if (st === 'gestures') {
        body.append(h('h3', null, 'What do your swipes mean?'), gestureEditor(draft, () => {}));
      } else if (st === 'services') {
        applyDraft(draft);
        const grid = h('div');
        body.append(h('h3', null, 'Pick your services'), h('p', { class: 'f-note' }, 'Each one connects straight from this phone. Tap one to connect it and see a preview card.'), grid);
        UI.renderPicker(grid, { onChange: () => { next.textContent = count() ? `Next (${count()} added)` : 'Skip for now'; } });
      } else if (st === 'done') {
        const names = Object.keys(M.settings().services).map((id) => M.services.get(id)).filter(Boolean);
        body.append(h('div', { class: 'mdf-donehero' }, '🌅'), h('h3', null, 'Your deck is ready'),
          h('p', { class: 'f-note' }, names.length ? `Cards from ${names.map((d) => d.name).join(', ')}, sorted by what’s most urgent. The last card is always a quick “How could this be better?”.` : 'No services yet. You can add your own reminders and services any time from ⚙ Settings.'),
          h('div', { class: 'mdf-privacybox' }, h('b', null, '🔒 Everything stays on this phone.'), ' Your settings, tokens, cards and answers live in this browser’s storage. Morning Deck has no server and no account. Clearing your browser data or tapping “Reset everything” erases it all.'));
      }
    }
    back.addEventListener('click', () => { if (i > 0) { i--; render(); } });
    next.addEventListener('click', async () => {
      if (steps[i] === 'name' || steps[i] === 'time' || steps[i] === 'gestures') applyDraft(draft);
      if (i < steps.length - 1) { i++; render(); return; }
      const s = applyDraft(draft); s.setupDone = true; s.setupAt = new Date().toISOString(); M.saveSettings(s);
      o.close(); UI.closeAll();
      MD.state.session = []; MD.state.history = [];
      await MD.loadConfig(); await MD.loadDeck({ initial: true });
      MD.toast('Your deck is ready 🌅', '#19c37d', 2200);
    });
    render();
  };

  // ---------- settings ----------
  const SECRET_KEYS = { todoist: ['token'], github: ['token'], ics: ['url', 'relay'], inbox: ['topic'] };
  function sanitized(includeSecrets) {
    const data = M.exportData();
    if (!includeSecrets) for (const [id, keys] of Object.entries(SECRET_KEYS)) { const sv = data.settings.services[id]; if (sv && sv.cfg) for (const k of keys) if (sv.cfg[k]) { sv.cfg[k] = ''; sv.needsSecret = true; } }
    data.includesSecrets = !!includeSecrets;
    return data;
  }
  function download(name, text) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name }); document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  UI.openSettings = function openSettings() {
    const o = UI.overlay('mdf-sheetish mdf-settings', 'Settings');
    const body = h('div', { class: 'mdf-scroll' });
    o.node.append(h('header', { class: 'mdf-head' }, h('button', { type: 'button', class: 'mdf-back', 'aria-label': 'Close settings', onclick: o.close }, '‹'), h('h2', null, 'Settings')), body);
    const draw = () => {
      const s = M.settings(); const draft = draftFrom(s);
      body.innerHTML = '';
      if (!s.setupDone) body.append(h('div', { class: 'mdf-callout' }, h('b', null, 'You’re looking at sample cards. '), 'Make the deck yours in about a minute.', h('button', { type: 'button', class: 'primary-btn', 'data-act': 'settings-wizard', onclick: () => { o.close(); UI.openWizard(); } }, 'Make it mine')));
      // you
      const save = () => { applyDraft(draft); MD.loadConfig(); };
      body.append(h('section', { class: 'mdf-sec' }, h('h3', null, 'You'),
        h('label', { class: 'f-label' }, 'Name for the greeting', h('input', { class: 'f-input', id: 'setName', maxlength: 40, value: draft.name, onchange: (e) => { draft.name = e.target.value; save(); } })),
        h('label', { class: 'f-label' }, 'Deck time (your day starts here)', h('input', { class: 'f-input', type: 'time', id: 'setTime', value: draft.deckTime, onchange: (e) => { draft.deckTime = e.target.value || '07:00'; save(); } })),
        h('details', { class: 'f-how' }, h('summary', null, 'Swipe meanings'), gestureEditor(draft, save))));
      // services
      const list = h('ul', { class: 'mdf-svclist' });
      const ids = Object.keys(s.services);
      if (!ids.length) list.append(h('li', { class: 'f-empty' }, 'No services yet.'));
      for (const id of ids) {
        const d = M.services.get(id); const st = s.services[id]; if (!d) continue;
        const line = st.needsSetup ? 'Needs setup by the app owner' : st.error ? `⚠ ${st.error}` : st.needsSecret ? '⚠ Add your token/link again (not included in the import)' : st.lastSync ? `Updated ${UI.ago(st.lastSync)}${st.warn ? ` · ${st.warn}` : ''}` : d.localCards && !d.fetch ? 'On this phone' : 'Not synced yet';
        const on = h('input', { type: 'checkbox', role: 'switch', checked: st.on !== false, 'aria-label': `${d.name} on/off`, onchange: (e) => { M.updateService(id, { on: e.target.checked }); MD.loadDeck(); } });
        list.append(h('li', { 'data-svc': id, style: `--accent:${d.color}` },
          h('span', { class: 'mdf-svcemoji' }, d.emoji),
          h('div', { class: 'mdf-svcmain' }, h('b', null, d.name, st.act ? h('span', { class: 'mdf-badge b-act' }, 'acts') : null), h('small', { class: st.error || st.needsSecret ? 'is-err' : '' }, line)),
          st.needsAuth && d.oauth ? h('button', { type: 'button', class: 'f-btn', onclick: async () => { try { await d.connect(); await M.syncService(id, { force: true }); MD.loadDeck(); draw(); } catch (e) { MD.toast(e.message, '#ff4f6d', 4000); } } }, 'Sign in') : null,
          h('button', { type: 'button', class: 'f-btn f-btn-soft', 'data-act': 'edit', onclick: () => UI.openService(id, { onDone: draw }) }, 'Edit'),
          h('label', { class: 'mdf-switch mdf-switch-sm' }, on, h('span', { class: 'mdf-switch-ui', 'aria-hidden': 'true' }))));
      }
      body.append(h('section', { class: 'mdf-sec' }, h('h3', null, 'Your services'), list,
        h('div', { class: 'f-row' },
          h('button', { type: 'button', class: 'f-btn', 'data-act': 'add-service', onclick: () => UI.openPicker({ onDone: draw }) }, '+ Add a service'),
          h('button', { type: 'button', class: 'f-btn f-btn-soft', 'data-act': 'refresh', onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Refreshing…'; await M.syncAll({ force: true }); await MD.loadDeck(); draw(); MD.toast('Refreshed', '#19c37d'); } }, 'Refresh now'))));
      // data
      const incl = h('input', { type: 'checkbox', id: 'exportSecrets' });
      const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, id: 'importFile', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const data = JSON.parse(await f.text()); M.importData(data); MD.state.session = []; MD.state.history = []; await MD.loadConfig(); await MD.loadDeck({ initial: true }); MD.toast('Imported ✓', '#19c37d'); draw(); }
        catch (err) { MD.toast(`Import failed: ${err.message}`, '#ff4f6d', 4200); }
        e.target.value = '';
      } });
      body.append(h('section', { class: 'mdf-sec' }, h('h3', null, 'Your data'),
        h('p', { class: 'f-note' }, 'Move your setup to another phone or browser, or keep a backup.'),
        h('label', { class: 'f-check' }, incl, h('span', null, 'Include tokens, secret links and inbox address'), h('small', { class: 'tag-relay' }, 'keep that file private')),
        h('div', { class: 'f-row' },
          h('button', { type: 'button', class: 'f-btn', 'data-act': 'export', onclick: () => { const d = sanitized(incl.checked); download(`morning-deck-backup-${M.ymd(new Date())}.json`, JSON.stringify(d, null, 2)); MD.toast(incl.checked ? 'Exported, including secrets. Keep the file private' : 'Exported (without secrets)', '#19c37d', 2600); } }, 'Export settings'),
          h('button', { type: 'button', class: 'f-btn f-btn-soft', 'data-act': 'import', onclick: () => file.click() }, 'Import'), file),
        h('p', { class: 'f-note' }, 'Google and Microsoft sign-ins are never exported; just sign in again on the new device.'),
        h('button', { type: 'button', class: 'ghost-btn mdf-danger', 'data-act': 'reset', onclick: async () => {
          if (!confirm('Reset everything? This erases all your settings, tokens, cards, answers and photos from this phone. It can’t be undone.')) return;
          await M.resetAll(); location.reload();
        } }, 'Reset everything')));
      // privacy & about
      body.append(h('section', { class: 'mdf-sec' }, h('h3', null, 'Privacy'),
        h('p', { class: 'mdf-privacybox' }, h('b', null, '🔒 Everything stays on this phone. '), 'Settings, tokens, cards, answers and photos are kept in this browser (localStorage and IndexedDB). Morning Deck has no server, no account, no analytics and no ads. Each service is contacted directly from this phone.'),
        h('ul', { class: 'mdf-plist' },
          h('li', null, h('b', null, 'Exceptions you choose: '), 'News feeds that block browsers go through rss2json.com (it sees the feed address). The Universal inbox uses ntfy.sh (anyone with your random address could read it; messages are kept about 12 hours).'),
          h('li', null, h('b', null, 'Google / Microsoft: '), 'sign-in happens on their pages. Morning Deck asks for read-only access, and write access only if you turn on “Let swipes act”.'),
          h('li', null, h('b', null, 'Feedback: '), 'stored here. It’s only shared if you tap Share or Email.'))));
      body.append(h('section', { class: 'mdf-sec mdf-about' }, h('h3', null, 'About'),
        h('p', { class: 'f-note' }, 'Morning Deck for Friends · runs entirely in your browser · ', h('a', { href: 'https://github.com/watsdr/morning-deck', target: '_blank', rel: 'noopener' }, 'open source (MIT)'), '.'),
        h('div', { class: 'f-row' }, h('button', { type: 'button', class: 'f-btn f-btn-soft', onclick: () => { o.close(); UI.showLanding(); } }, 'Show the intro'), h('button', { type: 'button', class: 'f-btn f-btn-soft', onclick: () => MD.install && document.getElementById('installBtn').click() }, 'Install help'))));
    };
    draw();
    return o;
  };
})();
