/* Morning Deck for Friends — connectors that work with no app registration:
 * Weather (Open-Meteo), News/RSS, My reminders, Todoist, GitHub, Calendar link (ICS). */
(() => {
  'use strict';
  const M = window.MDF;
  const { FriendlyError, http, clip, strip, fmtTime, relIn, ymd, startOfDay, addDays } = M;
  const { h, hash, until } = M.svcKit;
  const R = M.registerService;
  const SAFE_NOTE = 'Swipes only record your answer on this phone.';

  // ---------- Weather ----------
  const WMO = { 0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Cloudy', '☁️'], 45: ['Fog', '🌫️'], 48: ['Icy fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'] };
  const wmo = (c) => WMO[c] || ['Weather', '🌡️'];
  const imperialDefault = () => /-(US|LR|MM)$/i.test(navigator.language || '');
  R({
    id: 'weather', name: 'Weather', category: 'Everyday', emoji: '🌦️', color: '#38b6ff', status: 'ready',
    blurb: 'Umbrella, snow, heat, wind and UV alerts for your city, from Open-Meteo.',
    privacy: 'Only your city’s coordinates go to open-meteo.com (free, no account).',
    canAct: false, defaults: () => ({ units: imperialDefault() ? 'imperial' : 'metric' }),
    renderSetup(box, cfg, kit) {
      const results = h('div', { class: 'f-results' });
      const chosen = h('p', { class: 'f-chosen' }, cfg.place ? `📍 ${cfg.place}` : 'No place chosen yet.');
      const q = h('input', { type: 'search', class: 'f-input', placeholder: 'Search a city, e.g. Lisbon', 'aria-label': 'City', enterkeyhint: 'search' });
      const pick = (r) => { kit.setCfg({ lat: r.lat, lon: r.lon, place: r.place }); chosen.textContent = `📍 ${r.place}`; results.innerHTML = ''; kit.status(''); };
      const search = async () => {
        const name = q.value.trim(); if (name.length < 2) return;
        kit.status('Searching…');
        try {
          const j = await http(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=${encodeURIComponent((navigator.language || 'en').slice(0, 2))}&format=json`, { service: 'Open-Meteo' });
          results.innerHTML = ''; kit.status((j.results || []).length ? '' : 'No matches. Try another spelling.');
          for (const r of j.results || []) { const place = [r.name, r.admin1, r.country].filter(Boolean).join(', '); results.append(h('button', { type: 'button', class: 'f-result', onclick: () => pick({ lat: r.latitude, lon: r.longitude, place }) }, place)); }
        } catch (e) { kit.status(e.message, 'err'); }
      };
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      const units = h('select', { class: 'f-input', 'aria-label': 'Units', onchange: (e) => kit.setCfg({ units: e.target.value }) }, h('option', { value: 'metric' }, '°C, km/h, mm'), h('option', { value: 'imperial' }, '°F, mph, inches'));
      units.value = cfg.units || 'metric';
      box.append(
        h('div', { class: 'f-row' }, q, h('button', { type: 'button', class: 'f-btn', onclick: search }, 'Search')),
        h('button', { type: 'button', class: 'f-btn f-btn-soft', onclick: () => {
          if (!navigator.geolocation) return kit.status('This browser can’t share your location. Search instead.', 'err');
          kit.status('Asking for your location…');
          navigator.geolocation.getCurrentPosition((p) => pick({ lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3), place: `My location (${p.coords.latitude.toFixed(2)}, ${p.coords.longitude.toFixed(2)})` }),
            (e) => kit.status(e.code === 1 ? 'Location permission was denied. Search for your city instead.' : 'Couldn’t get your location. Search instead.', 'err'), { timeout: 10000, maximumAge: 3600e3 });
        } }, '📍 Use my location'),
        results, chosen, h('label', { class: 'f-label' }, 'Units', units));
    },
    validate: (cfg) => (cfg.lat == null ? 'Pick a city or use your location first.' : ''),
    async fetch(cfg) {
      const imp = cfg.units === 'imperial';
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${cfg.lat}&longitude=${cfg.lon}&current=temperature_2m,weather_code&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,snowfall_sum,uv_index_max,wind_gusts_10m_max&timezone=auto&forecast_days=2${imp ? '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch' : ''}`;
      const j = await http(u, { service: 'Open-Meteo' });
      const T = (x) => `${Math.round(x)}°`;
      const nowLocal = (j.current && j.current.time) || j.hourly.time[0];
      const late = +nowLocal.slice(11, 13) >= 20;
      const di = late ? 1 : 0; const date = j.daily.time[di]; const when = late ? 'Tomorrow' : 'Today';
      const d = (k) => j.daily[k][di];
      const hours = j.hourly.time.map((t, i) => ({ t, hr: +t.slice(11, 13), p: j.hourly.precipitation_probability[i], temp: j.hourly.temperature_2m[i], code: j.hourly.weather_code[i] }))
        .filter((x) => x.t.startsWith(date) && x.hr >= 7 && x.hr <= 21 && (late || x.t.slice(0, 13) >= nowLocal.slice(0, 13)));
      const hh = (hr) => new Date(2000, 0, 1, hr).toLocaleTimeString([], { hour: 'numeric' });
      const allHours = j.hourly.time.map((t, i) => ({ t, hr: +t.slice(11, 13), p: j.hourly.precipitation_probability[i], temp: j.hourly.temperature_2m[i], code: j.hourly.weather_code[i] })).filter((x) => x.t.startsWith(date) && x.hr >= 6 && x.hr <= 21 && x.hr % 3 === 0);
      const table = allHours.map((x) => `${hh(x.hr).padEnd(6)} ${T(x.temp).padStart(4)}  ${String(x.p ?? 0).padStart(3)}% rain  ${wmo(x.code)[0]}`).join('\n');
      const [desc, emo] = wmo(d('weather_code'));
      const range = `${T(d('temperature_2m_min'))}–${T(d('temperature_2m_max'))}`;
      const details = `${cfg.place || 'Your location'} · ${when.toLowerCase()}: ${desc.toLowerCase()}, ${range}\n\n${table}\n\nForecast data: Open-Meteo.com (CC BY 4.0)`;
      const base = { source: 'Weather', color: '#38b6ff', type: 'info', details, link: 'https://open-meteo.com/', linkLabel: 'Open-Meteo ↗', gestures: { right: { label: 'Thanks', value: 'ack' }, left: { label: 'Not useful', value: 'not_useful' } } };
      const cards = [];
      const wet = hours.filter((x) => (x.p ?? 0) >= 50);
      if (wet.length) {
        const peak = Math.max(...wet.map((x) => x.p));
        cards.push({ ...base, id: `weather-${date}-rain`, emoji: '☔', chip: 'Umbrella', priority: 'high', urgency: 5, title: `${when}: take an umbrella, rain likely ${hh(wet[0].hr)}–${hh(Math.min(23, wet[wet.length - 1].hr + 1))}`, body: `Up to ${peak}% chance of rain${d('precipitation_sum') ? ` (${d('precipitation_sum')} ${imp ? 'in' : 'mm'})` : ''}. ${desc}, ${range}. ${cfg.place || ''}`.trim() });
      }
      if (d('snowfall_sum') > 0) cards.push({ ...base, id: `weather-${date}-snow`, emoji: '❄️', chip: 'Snow', priority: 'high', urgency: 4, title: `${when}: snow expected`, body: `${d('snowfall_sum')} ${imp ? 'in' : 'cm'} of snow forecast, ${range}. Leave extra time.` });
      const hot = imp ? 90 : 32, cold = imp ? 23 : -5, gust = imp ? 37 : 60;
      if (d('temperature_2m_max') >= hot) cards.push({ ...base, id: `weather-${date}-heat`, emoji: '🥵', chip: 'Heat', priority: 'high', urgency: 6, title: `${when}: hot, up to ${T(d('temperature_2m_max'))}`, body: 'Drink water and find shade around midday.' });
      if (d('temperature_2m_min') <= cold) cards.push({ ...base, id: `weather-${date}-cold`, emoji: '🥶', chip: 'Cold', priority: 'normal', urgency: 10, title: `${when}: freezing, down to ${T(d('temperature_2m_min'))}`, body: 'Dress warm and watch for ice.' });
      if (d('wind_gusts_10m_max') >= gust) cards.push({ ...base, id: `weather-${date}-wind`, emoji: '💨', chip: 'Wind', priority: 'normal', urgency: 12, title: `${when}: strong gusts up to ${Math.round(d('wind_gusts_10m_max'))} ${imp ? 'mph' : 'km/h'}`, body: 'Secure loose things outside.' });
      if (d('uv_index_max') >= 8) cards.push({ ...base, id: `weather-${date}-uv`, emoji: '🧴', chip: 'UV', priority: 'normal', urgency: 20, title: `${when}: very high UV (${Math.round(d('uv_index_max'))})`, body: 'Sunscreen and a hat if you’re out at midday.' });
      if (!cards.length) cards.push({ ...base, id: `weather-${date}-summary`, emoji: emo, chip: 'Weather', priority: 'low', urgency: 50, title: `${when}: ${desc.toLowerCase()}, ${range}`, body: `${cfg.place || 'Your location'} · rain chance up to ${d('precipitation_probability_max') ?? 0}%. No alerts.` });
      return cards;
    },
  });

  // ---------- News / RSS ----------
  const FEEDS = [
    { id: 'nyt', name: 'New York Times · Top stories', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', direct: true, cat: 'News' },
    { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', direct: false, cat: 'News' },
    { id: 'guardian', name: 'The Guardian · World', url: 'https://www.theguardian.com/world/rss', direct: false, cat: 'News' },
    { id: 'npr', name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', direct: false, cat: 'News' },
    { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', direct: false, cat: 'News' },
    { id: 'fox', name: 'Fox News · Latest', url: 'https://moxie.foxnews.com/google-publisher/latest.xml', direct: true, cat: 'News' },
    { id: 'tagesschau', name: 'tagesschau (Deutsch)', url: 'https://www.tagesschau.de/index~rss2.xml', direct: true, cat: 'News' },
    { id: 'lemonde', name: 'Le Monde (Français)', url: 'https://www.lemonde.fr/rss/une.xml', direct: false, cat: 'News' },
    { id: 'nyttech', name: 'New York Times · Technology', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', direct: true, cat: 'Tech' },
    { id: 'wired', name: 'Wired', url: 'https://www.wired.com/feed/rss', direct: true, cat: 'Tech' },
    { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', direct: false, cat: 'Tech' },
    { id: 'ars', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', direct: false, cat: 'Tech' },
    { id: 'hn', name: 'Hacker News · Front page', url: 'https://hnrss.org/frontpage', direct: false, cat: 'Tech' },
    { id: 'devto', name: 'DEV Community', url: 'https://dev.to/feed', direct: true, cat: 'Tech' },
    { id: 'nasa', name: 'NASA News', url: 'https://www.nasa.gov/news-release/feed/', direct: true, cat: 'Science' },
    { id: 'espn', name: 'ESPN · Top headlines', url: 'https://www.espn.com/espn/rss/news', direct: true, cat: 'Sports' },
  ];
  R({
    id: 'news', name: 'News & RSS', category: 'Everyday', emoji: '📰', color: '#7c6cf2', status: 'ready',
    blurb: 'A few headlines a day from feeds you pick, or any RSS/Atom link.',
    privacy: 'Feeds marked “direct” are read straight from the publisher. The others go through rss2json.com, a free third-party relay that sees the feed address and your IP address. You can switch the relay off.',
    canAct: false, defaults: () => ({ feeds: ['nyt'], custom: [], relay: true, max: 5 }),
    renderSetup(box, cfg, kit) {
      const sel = new Set(cfg.feeds || []); const groups = {};
      for (const f of FEEDS) (groups[f.cat] = groups[f.cat] || []).push(f);
      for (const [cat, list] of Object.entries(groups)) {
        box.append(h('div', { class: 'f-sub' }, cat));
        for (const f of list) box.append(h('label', { class: 'f-check' }, h('input', { type: 'checkbox', checked: sel.has(f.id), 'data-feed': f.id, onchange: (e) => { e.target.checked ? sel.add(f.id) : sel.delete(f.id); kit.setCfg({ feeds: [...sel] }); } }), h('span', null, f.name), h('small', { class: f.direct ? 'tag-ok' : 'tag-relay' }, f.direct ? 'direct' : 'via relay')));
      }
      const custom = h('textarea', { class: 'f-input', rows: 2, placeholder: 'More feed links, one per line (https://…)', 'aria-label': 'Your own feeds', oninput: (e) => kit.setCfg({ custom: e.target.value.split(/\s+/).filter((x) => /^https?:\/\/\S+\.\S+/i.test(x)).slice(0, 10) }) });
      custom.value = (cfg.custom || []).join('\n');
      const max = h('select', { class: 'f-input', 'aria-label': 'How many headlines', onchange: (e) => kit.setCfg({ max: +e.target.value }) }, ...[3, 5, 8].map((n) => h('option', { value: n }, `${n} headlines a day`)));
      max.value = String(cfg.max || 5);
      box.append(h('div', { class: 'f-sub' }, 'Your own feeds'), custom, h('label', { class: 'f-label' }, 'How many', max),
        h('label', { class: 'f-check f-relay' }, h('input', { type: 'checkbox', checked: cfg.relay !== false, onchange: (e) => kit.setCfg({ relay: e.target.checked }) }), h('span', null, 'Use the free feed relay (rss2json.com) for feeds that block browser apps')),
        h('p', { class: 'f-note' }, 'Privacy: many publishers block browser apps from reading their feeds. For those, rss2json.com (a free third-party service) fetches the feed and passes it on. It sees the feed address and your IP address, but nothing from your other services. Feeds marked “direct” never use it.'));
    },
    validate: (cfg) => ((cfg.feeds || []).length + (cfg.custom || []).length ? '' : 'Pick at least one feed.'),
    async fetch(cfg, ctx) {
      const list = [...FEEDS.filter((f) => (cfg.feeds || []).includes(f.id)), ...(cfg.custom || []).map((u) => ({ id: hash(u), name: new URL(u).hostname.replace(/^www\./, ''), url: u, direct: null }))];
      const results = await Promise.allSettled(list.map((f) => M.fetchFeed(f.url, cfg.relay !== false && f.direct !== true, { knownBlocked: f.direct === false }).then((r) => ({ f, r }))));
      const items = []; const errs = [];
      results.forEach((x, i) => { if (x.status === 'fulfilled') x.value.r.items.slice(0, 6).forEach((it, k) => items.push({ ...it, rank: k, feed: x.value.f.direct === null ? (x.value.r.title || x.value.f.name) : x.value.f.name, via: x.value.r.via })); else errs.push(`${list[i].name}: ${x.reason.message}`); });
      if (!items.length && errs.length) throw new FriendlyError(errs[0]);
      ctx.save({ warn: errs.length ? errs.join(' · ') : '' });
      items.sort((a, b) => a.rank - b.rank || (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
      const seen = new Set();
      return items.filter((it) => it.title && !seen.has(it.title) && seen.add(it.title)).slice(0, cfg.max || 5).map((it, i) => ({
        id: `news-${hash(it.link || it.title)}`, source: clip(it.feed, 30), emoji: '📰', color: '#7c6cf2', type: 'info', priority: 'low', urgency: 60 + i, chip: 'Headline',
        title: clip(it.title, 140), body: clip(it.summary || 'Open the card for the link.', 220), meta: it.date && !isNaN(Date.parse(it.date)) ? relIn(new Date(it.date)) : undefined,
        details: `${it.feed}${it.via === 'relay' ? ' · fetched via rss2json.com' : ' · read directly from the publisher'}`, link: /^https?:/i.test(it.link || '') ? it.link : undefined, linkLabel: 'Read it ↗',
        gestures: { right: { label: 'Interesting', value: 'interesting' }, left: { label: 'Not for me', value: 'not_for_me' } } }));
    },
  });

  // ---------- My reminders (manual cards) ----------
  const REPEATS = { none: 'Once', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week', monthly: 'Every month' };
  function manualDue(r, day) {
    const d = new Date(day + 'T12:00:00'); const s = r.date ? new Date(r.date + 'T12:00:00') : null;
    if (s && d < s) return false;
    switch (r.repeat || 'none') {
      case 'daily': return true;
      case 'weekdays': return d.getDay() > 0 && d.getDay() < 6;
      case 'weekly': return !s || d.getDay() === s.getDay();
      case 'monthly': return !s || d.getDate() === s.getDate();
      default: return true; // once: shows from its date until answered
    }
  }
  R({
    id: 'manual', name: 'My reminders', category: 'Everyday', emoji: '🪴', color: '#19c37d', status: 'ready',
    blurb: 'Your own cards: once, daily, weekdays, weekly or monthly.', privacy: 'Stored only on this phone.', canAct: false, noTest: true, defaults: () => ({}),
    renderSetup(box, cfg, kit) {
      const listEl = h('ul', { class: 'f-list' });
      const draw = () => {
        listEl.innerHTML = '';
        const items = M.settings().manual;
        if (!items.length) listEl.append(h('li', { class: 'f-empty' }, 'No reminders yet.'));
        for (const r of items) listEl.append(h('li', null, h('span', null, `${r.emoji || '🔔'} ${r.title}`), h('small', null, `${REPEATS[r.repeat || 'none']}${r.date ? ` · from ${r.date}` : ''}${r.time ? ` · ${r.time}` : ''}`),
          h('button', { type: 'button', class: 'f-x', 'aria-label': `Remove ${r.title}`, onclick: () => { const s = M.settings(); s.manual = s.manual.filter((x) => x.id !== r.id); M.saveSettings(s); draw(); } }, '✕')));
      };
      const title = h('input', { class: 'f-input', placeholder: 'e.g. Take vitamins', maxlength: 120, 'aria-label': 'Reminder' });
      const note = h('input', { class: 'f-input', placeholder: 'Note (optional)', maxlength: 300, 'aria-label': 'Note' });
      const date = h('input', { class: 'f-input', type: 'date', value: ymd(new Date()), 'aria-label': 'Starting' });
      const time = h('input', { class: 'f-input', type: 'time', 'aria-label': 'Time (optional)' });
      const rep = h('select', { class: 'f-input', 'aria-label': 'Repeat' }, ...Object.entries(REPEATS).map(([k, v]) => h('option', { value: k }, v)));
      const pr = h('select', { class: 'f-input', 'aria-label': 'Priority' }, h('option', { value: 'normal' }, 'Normal priority'), h('option', { value: 'high' }, 'High priority'), h('option', { value: 'low' }, 'Low priority'));
      const add = () => {
        if (!title.value.trim()) { kit.status('Give the reminder a title.', 'err'); title.focus(); return; }
        const s = M.settings(); s.manual.push({ id: M.uid().replace(/-/g, '').slice(0, 10), title: title.value.trim(), note: note.value.trim(), date: date.value, time: time.value, repeat: rep.value, priority: pr.value, createdAt: new Date().toISOString() }); M.saveSettings(s);
        title.value = ''; note.value = ''; kit.status('Added ✓', 'ok'); draw(); kit.testNow();
      };
      box.append(listEl, h('div', { class: 'f-sub' }, 'Add a reminder'), title, note, h('div', { class: 'f-row' }, date, time), h('div', { class: 'f-row' }, rep, pr), h('button', { type: 'button', class: 'f-btn', onclick: add }, '+ Add reminder'));
      draw();
    },
    localCards(cfg, ctx) {
      const day = ctx.deckDay();
      return M.settings().manual.filter((r) => manualDue(r, day)).map((r) => ({
        id: (r.repeat || 'none') === 'none' ? `manual-${r.id}` : `manual-${r.id}-${day}`, source: 'Reminder', emoji: r.emoji || '🔔', color: '#19c37d', type: 'question', generic: true,
        priority: r.priority || 'normal', urgency: r.time ? Math.round((+r.time.slice(0, 2) * 60 + +r.time.slice(3, 5)) / 15) : 50, chip: REPEATS[r.repeat || 'none'],
        title: r.title, body: [r.time ? `At ${r.time}` : '', r.note].filter(Boolean).join(' · ') || 'Your reminder.', meta: r.time ? `today ${r.time}` : 'today' }));
    },
    test(cfg, ctx) { return this.localCards(cfg, ctx); },
  });

  // ---------- Todoist ----------
  const TD = 'https://api.todoist.com/api/v1';
  const tdH = () => ({ Authorization: `Bearer ${((M.svcState('todoist') || {}).cfg || {}).token}` });
  R({
    id: 'todoist', name: 'Todoist', category: 'Tasks', emoji: '✅', color: '#e44332', status: 'ready',
    blurb: 'Overdue and due-today tasks. Optional: swipe right to complete.',
    privacy: 'Your Todoist API token is stored only on this phone and sent only to api.todoist.com.',
    canAct: true, actHelp: 'Swiping right (“Done”) completes the task in Todoist, and Undo reopens it. Recurring tasks are only recorded, because completing one moves its date.',
    fields: [{ key: 'token', label: 'Todoist API token', type: 'password', secret: true, placeholder: 'Paste your token', help: 'Todoist → Settings → Integrations → Developer → copy “API token”.', link: 'https://app.todoist.com/app/settings/integrations/developer' }],
    validate: (cfg) => (/^[a-f0-9]{30,64}$/i.test((cfg.token || '').trim()) ? '' : 'That doesn’t look like a Todoist API token (40 letters and numbers).'),
    async test(cfg, ctx) { const u = await http(`${TD}/user`, { headers: { Authorization: `Bearer ${cfg.token}` }, service: 'Todoist' }); ctx.save({ account: u.full_name || u.email || '' }); return this.fetch(cfg, ctx); },
    async fetch(cfg) {
      const H = { Authorization: `Bearer ${cfg.token}` };
      const [tasks, projects] = await Promise.all([
        http(`${TD}/tasks/filter?query=${encodeURIComponent('today | overdue')}&limit=100`, { headers: H, service: 'Todoist' }),
        http(`${TD}/projects?limit=200`, { headers: H, service: 'Todoist' }).catch(() => ({ results: [] })),
      ]);
      const pname = Object.fromEntries((projects.results || []).map((p) => [p.id, p.name]));
      const today = ymd(new Date());
      return (tasks.results || []).slice(0, 20).map((t) => {
        const due = t.due || {}; const dd = (due.date || '').slice(0, 10);
        const overdue = !!dd && dd < today; const days = overdue ? Math.round((new Date(today) - new Date(dd)) / 86400e3) : 0;
        const at = due.datetime ? new Date(due.datetime) : (due.date && due.date.length > 10 ? new Date(due.date) : null);
        return { id: `todoist-${t.id}-${dd}`, source: 'Todoist', emoji: '✅', color: '#e44332', type: 'question', ref: { taskId: t.id, recurring: !!due.is_recurring },
          priority: overdue || t.priority === 4 ? 'high' : 'normal', urgency: overdue ? Math.max(0, 10 - days) : at ? Math.min(99, 15 + Math.round(until(at) / 30)) : 30 - (t.priority || 1) * 2,
          chip: overdue ? `Overdue ${days} day${days > 1 ? 's' : ''}` : at ? `Due ${fmtTime(at)}` : 'Due today',
          title: clip(String(t.content || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), 140), body: [pname[t.project_id], t.description && clip(t.description, 140), due.is_recurring ? `repeats ${due.string || ''}`.trim() : ''].filter(Boolean).join(' · ') || 'From Todoist',
          link: `https://app.todoist.com/app/task/${t.id}`, linkLabel: 'Open in Todoist ↗',
          gestures: { right: { label: 'Done', value: 'done', action: due.is_recurring ? undefined : 'close' }, left: { label: 'Not today', value: 'not_today' } } };
      });
    },
    actions: {
      close: { run: async (card) => { await http(`${TD}/tasks/${card.ref.taskId}/close`, { method: 'POST', headers: tdH(), json: false, service: 'Todoist' }); return { taskId: card.ref.taskId }; },
        undo: async (card, res) => { await http(`${TD}/tasks/${res.taskId}/reopen`, { method: 'POST', headers: tdH(), json: false, service: 'Todoist' }); } },
    },
  });

  // ---------- GitHub ----------
  const GH = 'https://api.github.com';
  const ghH = (cfg) => ({ Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
  R({
    id: 'github', name: 'GitHub', category: 'Work & code', emoji: '🐙', color: '#6e5494', status: 'ready',
    blurb: 'Pull requests waiting for your review, issues assigned to you, unread notifications.',
    privacy: 'Your GitHub token is stored only on this phone and sent only to api.github.com. Use a read-only token.',
    canAct: false, actHelp: SAFE_NOTE,
    fields: [{ key: 'token', label: 'GitHub token (read-only)', type: 'password', secret: true, placeholder: 'github_pat_… or ghp_…', help: 'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained. Pick your repositories, then Repository permissions: Metadata, Pull requests, Issues = Read-only. Notifications only work with a classic token that has the “notifications” scope; otherwise they’re skipped.', link: 'https://github.com/settings/personal-access-tokens/new' }],
    validate: (cfg) => (/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test((cfg.token || '').trim()) ? '' : 'That doesn’t look like a GitHub token (it starts with github_pat_ or ghp_).'),
    async test(cfg, ctx) { const u = await http(`${GH}/user`, { headers: ghH(cfg), service: 'GitHub' }); ctx.save({ account: u.login }); return this.fetch(cfg, ctx); },
    async fetch(cfg, ctx) {
      const q = (s) => http(`${GH}/search/issues?q=${encodeURIComponent(s)}&per_page=10&sort=updated`, { headers: ghH(cfg), service: 'GitHub' });
      const [rev, asg, notes] = await Promise.all([q('is:open is:pr review-requested:@me archived:false'), q('is:open assignee:@me archived:false'), http(`${GH}/notifications?per_page=10`, { headers: ghH(cfg), service: 'GitHub' }).catch(() => null)]);
      const repo = (it) => (it.repository_url || '').split('/').slice(-2).join('/');
      const cards = []; const seen = new Set();
      for (const it of rev.items || []) { seen.add(it.html_url); cards.push({ id: `github-rr-${it.id}`, source: 'GitHub', emoji: '🐙', color: '#6e5494', type: 'question', priority: 'high', urgency: 20, chip: 'Review requested',
        title: `Review: ${clip(it.title, 110)} (#${it.number})`, body: `${repo(it)} · by ${it.user ? it.user.login : 'someone'} · updated ${relIn(new Date(it.updated_at))}`, link: it.html_url, linkLabel: 'Open on GitHub ↗',
        gestures: { right: { label: 'On it', value: 'on_it' }, left: { label: 'Not now', value: 'not_now' } } }); }
      for (const it of asg.items || []) { if (seen.has(it.html_url)) continue; seen.add(it.html_url); cards.push({ id: `github-as-${it.id}-${String(it.updated_at).slice(0, 10)}`, source: 'GitHub', emoji: it.pull_request ? '🔀' : '🐞', color: '#6e5494', type: 'question', priority: 'normal', urgency: 40, chip: it.pull_request ? 'Assigned PR' : 'Assigned issue',
        title: `${clip(it.title, 120)} (#${it.number})`, body: `${repo(it)} · ${it.comments} comment${it.comments === 1 ? '' : 's'} · updated ${relIn(new Date(it.updated_at))}`, link: it.html_url, linkLabel: 'Open on GitHub ↗',
        gestures: { right: { label: 'On it', value: 'on_it' }, left: { label: 'Not today', value: 'not_today' } } }); }
      if (Array.isArray(notes)) {
        const unread = notes.filter((n) => n.unread).slice(0, 5);
        if (unread.length) cards.push({ id: `github-notes-${M.deckDay()}`, source: 'GitHub', emoji: '🔔', color: '#6e5494', type: 'info', priority: 'low', urgency: 60, chip: 'Notifications',
          title: `${unread.length}${notes.length >= 10 ? '+' : ''} unread GitHub notification${unread.length > 1 ? 's' : ''}`, body: unread.slice(0, 3).map((n) => clip(n.subject.title, 60)).join(' · '),
          details: unread.map((n) => `${n.repository.full_name}: ${n.subject.title} (${n.reason})`).join('\n'), link: 'https://github.com/notifications', linkLabel: 'Open notifications ↗' });
        ctx.save({ warn: '' });
      } else ctx.save({ warn: 'Notifications skipped (they need a classic token with the “notifications” scope).' });
      return cards;
    },
  });

  // ---------- Calendar link (ICS) ----------
  R({
    id: 'ics', name: 'Calendar link (ICS)', category: 'Calendar', emoji: '🗓️', color: '#4f7cff', status: 'ready', caveat: 'Most providers block browser apps from reading these links',
    blurb: 'A secret iCal link or an .ics file: first meeting, conflicts, all-day items.',
    privacy: 'The secret link is stored only on this phone. Treat it like a password: anyone with it can read your calendar.',
    canAct: false, actHelp: SAFE_NOTE,
    renderSetup(box, cfg, kit) {
      const url = h('input', { class: 'f-input', type: 'url', placeholder: 'https://…/basic.ics or webcal://…', value: cfg.url || '', 'aria-label': 'Secret iCal link', oninput: (e) => kit.setCfg({ url: e.target.value.trim() }) });
      const email = h('input', { class: 'f-input', type: 'email', placeholder: 'you@example.com (optional)', value: cfg.email || '', 'aria-label': 'Your email', oninput: (e) => kit.setCfg({ email: e.target.value.trim() }) });
      const relay = h('input', { class: 'f-input', type: 'url', placeholder: 'https://your-relay.example/?url=', value: cfg.relay || '', 'aria-label': 'Advanced: your own relay', oninput: (e) => kit.setCfg({ relay: e.target.value.trim() }) });
      const file = h('input', { type: 'file', accept: '.ics,text/calendar', class: 'f-file', 'aria-label': 'Import an .ics file', onchange: async (e) => { const f = e.target.files[0]; if (!f) return; const t = await f.text(); if (!/BEGIN:VCALENDAR/.test(t)) return kit.status('That file isn’t an .ics calendar.', 'err'); M.ls.set('svc.ics.file', { name: f.name, text: t.slice(0, 2e6), at: new Date().toISOString() }); kit.setCfg({ file: f.name }); kit.status(`Imported ${f.name} ✓ (a snapshot, so re-import it to update)`, 'ok'); } });
      box.append(
        h('label', { class: 'f-label' }, 'Secret iCal link', url),
        h('details', { class: 'f-how' }, h('summary', null, 'Where do I find it?'), h('ul', null,
          h('li', null, h('b', null, 'Google Calendar: '), 'calendar.google.com on a computer → ⚙ Settings → your calendar → “Secret address in iCal format”.'),
          h('li', null, h('b', null, 'Outlook.com / Microsoft 365: '), 'Settings → Calendar → Shared calendars → Publish a calendar → ICS link.'),
          h('li', null, h('b', null, 'iCloud: '), 'Calendar → (i) next to a calendar → Public Calendar → copy the link.'),
          h('li', null, h('b', null, 'Fastmail: '), 'Settings → Calendars → your calendar → Export / sharing → iCal link.'))),
        h('p', { class: 'f-note f-warn' }, 'Heads-up: Google, Outlook and iCloud don’t let browser apps read these links (no CORS headers), and Morning Deck has no server to fetch them for you. If the test fails, use ', h('b', null, 'Google or Microsoft sign-in'), ' instead (if it’s set up), ', h('b', null, 'import an .ics file'), ' (a snapshot), or ', h('b', null, 'a relay you run yourself'), ' (Advanced).'),
        h('label', { class: 'f-label' }, 'Your email (optional, to spot invites you haven’t answered)', email),
        h('label', { class: 'f-label' }, 'Or import an .ics file', file),
        h('details', { class: 'f-how' }, h('summary', null, 'Advanced: your own relay'), h('p', { class: 'f-note' }, 'A URL prefix that fetches the link for you; the calendar link is added to the end, URL-encoded. Only use a relay you run or trust, because it can read your calendar.'), relay));
    },
    validate: (cfg) => (cfg.url || cfg.file ? (cfg.url && !/^(https?|webcal):\/\//i.test(cfg.url) ? 'The link should start with https:// or webcal://' : '') : 'Paste your secret iCal link or import an .ics file.'),
    async fetch(cfg, ctx) {
      let text = null; let note = '';
      if (cfg.url) {
        const url = cfg.url.replace(/^webcal:/i, 'https:');
        try { text = await (await http(url, { json: false, service: new URL(url).hostname })).text(); }
        catch (e) {
          if (cfg.relay) { try { text = await (await http(cfg.relay + encodeURIComponent(url), { json: false, service: 'your relay' })).text(); } catch (e2) { if (!cfg.file) throw e2; } }
          else if (!cfg.file) throw new FriendlyError(e.cors ? `${new URL(url).hostname} doesn’t let browser apps read calendar links (no CORS), and Morning Deck has no server. Use Google/Microsoft sign-in, import an .ics file, or set your own relay (Advanced).` : e.message, { cors: e.cors });
          if (!text) note = 'Link blocked by the provider; showing your imported file.';
        }
      }
      if (!text) { const f = M.ls.get('svc.ics.file', null); if (!f) throw new FriendlyError('No calendar data yet.'); text = f.text; note = note || `From the imported file ${f.name} (re-import to update).`; }
      if (!/BEGIN:VCALENDAR/.test(text)) throw new FriendlyError('That link didn’t return a calendar (.ics).');
      const sod = startOfDay(new Date());
      const events = M.parseICS(text, { myEmail: cfg.email, from: sod, to: addDays(sod, 8) });
      ctx.save({ warn: note });
      return M.calendarCards(events, { svc: 'ics', source: 'Calendar', emoji: '🗓️', color: '#4f7cff' });
    },
  });
  M.FEEDS = FEEDS;
})();
