/* Morning Deck for Friends — Universal inbox (via ntfy) and the "coming soon" list. */
(() => {
  'use strict';
  const M = window.MDF; const CFG = M.CFG;
  const { http, clip, relIn } = M; const { h } = M.svcKit;
  const R = M.registerService;

  // ---------- Universal inbox (ntfy.sh or your own ntfy server) ----------
  const randTopic = () => { const a = new Uint8Array(24); crypto.getRandomValues(a); return 'md-' + [...a].map((b) => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('').slice(0, 22); };
  const PRI = { 5: 'high', 4: 'high', 3: 'normal', 2: 'low', 1: 'low' };
  function inboxCard(m) {
    let data = {}; const raw = String(m.message || '');
    if (/^\s*\{/.test(raw)) { try { data = JSON.parse(raw) || {}; } catch (_) { data = {}; } }
    const tags = m.tags || [];
    const from = (tags.find((t) => /^from-/.test(t)) || '').slice(5).replace(/-/g, ' ');
    const at = new Date((m.time || Date.now() / 1000) * 1000);
    const pr = ['high', 'normal', 'low'].includes(data.priority) ? data.priority : PRI[m.priority || 3] || 'normal';
    const title = data.title || m.title || (data.body ? '' : raw) || 'New card';
    const body = data.body || (data.title || m.title ? (data.title ? '' : raw) : '');
    const custom = data.right || data.left;
    const card = { id: `inbox-${m.id}`, source: clip(data.source || (from ? from.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Inbox'), 28), emoji: clip(data.emoji || TAG_EMOJI[tags.find((t) => TAG_EMOJI[t])] || '📥', 4), color: '#18bcf2',
      type: ['question', 'choice', 'info'].includes(data.type) ? data.type : 'info', priority: pr, urgency: 40, chip: 'Universal inbox', meta: relIn(at), title: clip(title, 140), body: clip(body, 300),
      link: /^https?:\/\//i.test(data.link || m.click || '') ? (data.link || m.click) : undefined, generic: !custom };
    if (custom) card.gestures = Object.fromEntries([['right', data.right], ['left', data.left]].filter(([, v]) => v).map(([k, v]) => [k, { label: clip(String(v), 20) }]));
    return card;
  }
  // a few common ntfy tag names → emoji (ntfy uses emoji short codes as tags)
  const TAG_EMOJI = { warning: '⚠️', rotating_light: '🚨', white_check_mark: '✅', wastebasket: '🗑️', house: '🏠', package: '📦', calendar: '📅', bell: '🔔', wave: '👋', car: '🚗', zap: '⚡', moneybag: '💰', pill: '💊', dog: '🐶', cat: '🐱', plant: '🪴', shopping_cart: '🛒', email: '✉️', tada: '🎉', fire: '🔥', droplet: '💧', sunny: '☀️', umbrella: '☔', bulb: '💡', lock: '🔒', baby: '👶', soccer: '⚽', robot: '🤖' };
  R({
    id: 'inbox', name: 'Universal inbox', category: 'Automations', emoji: '📥', color: '#18bcf2', status: 'ready', staleMs: 0,
    blurb: 'Let Zapier, IFTTT, Make, Apple Shortcuts, Home Assistant, or anything that can send a web request, drop cards into your deck.',
    privacy: 'Uses ntfy.sh, a free public relay, with a random private topic name. Anyone who knows the topic can read or post to it, so treat it like a password. Messages wait on ntfy.sh for about 12 hours (open the app at least twice a day so none expire), travel over HTTPS, and are not end-to-end encrypted. Don’t send passwords or very private details. You can self-host ntfy and change the server here.',
    canAct: false, actHelp: 'Swipes only record your answer on this phone.',
    defaults: () => ({ server: CFG.ntfyServer || 'https://ntfy.sh', topic: randTopic() }),
    renderSetup(box, cfg, kit) {
      if (!cfg.topic) kit.setCfg({ topic: randTopic() });
      const c = () => kit.getCfg();
      const code = (txt, label) => h('div', { class: 'f-codewrap' }, h('pre', { class: 'f-code', 'aria-label': label || 'Example' }, txt), h('button', { type: 'button', class: 'f-copy', onclick: (e) => {
        const b = e.currentTarget;
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = 'Copy'), 1500); }, () => kit.status('Copy failed: long-press the text to copy it.', 'err'));
      } }, 'Copy'));
      const holder = h('div', { class: 'f-inbox' });
      const draw = () => {
        const S = (c().server || 'https://ntfy.sh').replace(/\/$/, ''), T = c().topic;
        const json = JSON.stringify({ topic: T, title: 'Bins go out tonight', message: 'Green bin this week', priority: 4, tags: ['wastebasket', 'from-home'] }, null, 2);
        holder.innerHTML = '';
        holder.append(
          h('p', { class: 'f-note' }, 'Your private inbox address. Keep it secret:'), code(`${S}/${T}`, 'Your inbox address'),
          h('p', { class: 'f-note' }, 'Every tool below sends one JSON POST to ', h('code', null, `${S}/`), '. Fields: ', h('code', null, 'title'), ', ', h('code', null, 'message'), ', ', h('code', null, 'priority'), ' (1–5, where 4–5 means high), ', h('code', null, 'tags'), ' (an emoji name, or ', h('code', null, 'from-zapier'), ' to set the source), and ', h('code', null, 'click'), ' (a link).'),
          code(json, 'JSON example'),
          ...[
            ['Zapier', `Action: “Webhooks by Zapier” → POST\nURL: ${S}/\nPayload Type: json\nData:\n  topic     ${T}\n  title     (pick a field)\n  message   (pick a field)\n  priority  3\n  tags      from-zapier`],
            ['IFTTT', `Then: “Webhooks” → “Make a web request” (needs IFTTT Pro)\nURL: ${S}/\nMethod: POST\nContent Type: application/json\nBody:\n{"topic":"${T}","title":"{{EventName}}","message":"{{Value1}}","tags":["from-ifttt"]}`],
            ['Make', `Module: HTTP → “Make a request”\nURL: ${S}/\nMethod: POST\nBody type: Raw · Content type: JSON (application/json)\nRequest content:\n{"topic":"${T}","title":"{{1.subject}}","message":"{{1.text}}","tags":["from-make"]}`],
            ['Apple Shortcuts', `Action: “Get Contents of URL”\nURL: ${S}/\nMethod: POST\nRequest Body: JSON\n  topic     (Text)    ${T}\n  title     (Text)    Your title\n  message   (Text)    Your message\n  priority  (Number)  3\n  tags      (Array)   from-shortcuts\nTip: Apple Reminders and Calendar have no web API. A Shortcuts automation like this one is how they reach your deck.`],
            ['Home Assistant', `# configuration.yaml\nrest_command:\n  morning_deck:\n    url: "${S}/"\n    method: POST\n    content_type: "application/json"\n    payload: '{"topic":"${T}","title":"{{ title }}","message":"{{ message }}","priority":{{ priority | default(3) }},"tags":["house","from-home-assistant"]}'\n\n# then, in an automation:\naction: rest_command.morning_deck\ndata:\n  title: "Washing machine finished"\n  message: "Time to hang it up"`],
            ['curl / anything else', `curl -H "Title: Bins go out tonight" -H "Priority: 4" -H "Tags: wastebasket" \\\n  -d "Green bin this week" ${S}/${T}`],
          ].map(([name, txt]) => h('details', { class: 'f-how', 'data-platform': name }, h('summary', null, name), code(txt, `${name} instructions`))),
          h('p', { class: 'f-note' }, 'Advanced: send a JSON message body like ', h('code', null, '{"title":"Pick up the kids?","type":"question","right":"I’ll go","left":"Can’t"}'), ' to set your own swipe labels.'));
      };
      const server = h('input', { class: 'f-input', type: 'url', value: cfg.server || CFG.ntfyServer, 'aria-label': 'ntfy server', onchange: (e) => { kit.setCfg({ server: e.target.value.trim().replace(/\/$/, '') || 'https://ntfy.sh' }); M.ls.del('svc.inbox.since'); draw(); } });
      box.append(
        holder,
        h('div', { class: 'f-row' },
          h('button', { type: 'button', class: 'f-btn', 'data-act': 'send-test', onclick: async () => {
            kit.status('Sending a test card…');
            try {
              const S = (c().server || 'https://ntfy.sh').replace(/\/$/, '');
              await http(`${S}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: c().topic, title: 'Hello from your universal inbox 👋', message: 'If you can see this card, your automations can reach your deck.', tags: ['wave', 'from-morning-deck'], priority: 3 }), service: new URL(S).host });
              kit.status('Sent ✓ Checking that it arrives…', 'ok'); setTimeout(() => kit.testNow(), 800);
            } catch (e) { kit.status(e.message, 'err'); }
          } }, 'Send a test card'),
          h('button', { type: 'button', class: 'f-btn f-btn-soft', onclick: () => { if (!confirm('Make a new private address? Automations using the old one will stop reaching you.')) return; kit.setCfg({ topic: randTopic() }); M.ls.del('svc.inbox.since'); draw(); kit.status('New address made. Update your automations.', 'ok'); } }, 'New address')),
        h('details', { class: 'f-how' }, h('summary', null, 'Use your own ntfy server'), h('label', { class: 'f-label' }, 'Server', server)));
      draw();
    },
    validate: (cfg) => (cfg.topic && /^[\w-]{12,64}$/.test(cfg.topic) ? '' : 'Missing inbox address.'),
    async fetch(cfg, ctx) {
      const S = (cfg.server || 'https://ntfy.sh').replace(/\/$/, '');
      const since = ctx.store.get('since', '24h');
      const r = await http(`${S}/${encodeURIComponent(cfg.topic)}/json?poll=1&since=${encodeURIComponent(since)}`, { json: false, service: new URL(S).host, timeout: 10000 });
      const lines = (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && m.event === 'message' && m.id);
      const keep = ctx.store.get('messages', []); const ids = new Set(keep.map((m) => m.id));
      const fresh = lines.filter((m) => !ids.has(m.id));
      ctx.store.set('messages', [...keep, ...fresh].filter((m) => Date.now() / 1000 - (m.time || 0) < 7 * 86400).slice(-200));
      if (lines.length) ctx.store.set('since', lines[lines.length - 1].id);
      ctx.save({ newCount: fresh.length });
      return [];
    },
    localCards(cfg, ctx) { return ctx.store.get('messages', []).map(inboxCard); },
    async test(cfg, ctx) { await this.fetch(cfg, ctx); const list = this.localCards(cfg, ctx); return list.length ? list.slice(-3).reverse() : [{ id: 'inbox-waiting', source: 'Inbox', emoji: '📥', color: '#18bcf2', type: 'info', chip: 'Universal inbox', title: 'Connected. No cards yet.', body: 'Tap “Send a test card”, or send one from your automation.' }]; },
  });

  // ---------- Coming soon (each with a one-line reason) ----------
  const soon = (id, name, emoji, reason) => R({ id, name, emoji, category: 'Coming soon', status: 'soon', reason, color: '#8a8aa8' });
  soon('notion', 'Notion', '📝', 'Notion’s API does work from browser apps, but each friend has to create an integration and pick which database counts as “today”, so it needs a mapping screen first.');
  soon('slack', 'Slack', '💬', 'Reading your Slack needs a Slack app installed in each workspace plus its token; there’s no simple personal sign-in for a serverless app yet.');
  soon('apple', 'Apple Reminders & Calendar', '🍎', 'Apple has no web API. Until then, use an Apple Shortcuts automation that posts to your Universal inbox.');
  soon('spotify', 'Spotify', '🎧', 'Needs the app owner to register a Spotify app, and unreviewed apps are capped at 25 named users.');
  soon('whatsapp', 'WhatsApp', '🟢', 'WhatsApp has no API for reading your personal chats.');
  soon('strava', 'Strava', '🚴', 'Strava’s sign-in needs a client secret, which a serverless app can’t keep secret.');
  soon('trello', 'Trello', '📋', 'Planned: a personal-token connector (Trello’s API allows browser apps).');
  soon('asana', 'Asana', '🎯', 'Planned: a personal-access-token connector (Asana’s API allows browser apps).');
  soon('linear', 'Linear', '📐', 'Planned: a personal API key connector (Linear’s API allows browser apps).');
  soon('jira', 'Jira', '🧩', 'Atlassian doesn’t reliably allow browser apps with personal API tokens, so Jira would likely need a relay.');
  soon('discord', 'Discord', '🎮', 'Discord has no API for reading your personal messages or mentions.');
  soon('social', 'Instagram / X', '📸', 'There’s no free API for reading your own feed or messages.');
  soon('health', 'Health Connect / Fitbit', '❤️', 'Health Connect only works in native Android apps, and Fitbit needs the owner to register an app.');

  M.inboxCard = inboxCard; M.randTopic = randTopic;
})();
