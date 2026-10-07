/* Morning Deck for Friends — ICS (iCalendar) and RSS/Atom parsing, all in the browser. */
(() => {
  'use strict';
  const M = window.MDF; const CFG = M.CFG;
  const { FriendlyError, http, clip, strip } = M; const { hash } = M.svcKit;

  // ---------- ICS ----------
  const WIN_TZ = { 'UTC': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest', 'Russian Standard Time': 'Europe/Moscow', 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage', 'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'Canada Central Standard Time': 'America/Regina', 'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Buenos_Aires', 'SA Pacific Standard Time': 'America/Bogota', 'Central Standard Time (Mexico)': 'America/Mexico_City', 'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'Singapore Standard Time': 'Asia/Singapore', 'Arabian Standard Time': 'Asia/Dubai', 'Israel Standard Time': 'Asia/Jerusalem', 'South Africa Standard Time': 'Africa/Johannesburg', 'AUS Eastern Standard Time': 'Australia/Sydney', 'E. Australia Standard Time': 'Australia/Brisbane', 'W. Australia Standard Time': 'Australia/Perth', 'New Zealand Standard Time': 'Pacific/Auckland' };
  const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
  function tzOffsetMin(date, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime()) / 60000;
  }
  function wallToDate(w, tz) { // wall-clock fields in zone tz -> Date (floating = device time)
    if (!tz) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    if (tz === 'UTC') return new Date(guess);
    let t = guess - tzOffsetMin(new Date(guess), tz) * 60000;
    t = guess - tzOffsetMin(new Date(t), tz) * 60000;
    return new Date(t);
  }
  function parseIcsDate(val, params = {}) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(val).trim());
    if (!m) return null;
    const w = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
    if (!m[4] || params.VALUE === 'DATE') return { allDay: true, w, tz: null };
    let tz = m[7] ? 'UTC' : params.TZID ? String(params.TZID).replace(/^"|"$/g, '') : null;
    if (tz && tz !== 'UTC') { tz = WIN_TZ[tz] || tz; if (!validTz(tz)) tz = null; }
    return { allDay: false, w, tz };
  }
  const toDate = (pd) => (pd.allDay ? new Date(pd.w.y, pd.w.mo - 1, pd.w.d) : wallToDate(pd.w, pd.tz));
  const unesc = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  function parseICS(text, { myEmail = '', from, to } = {}) {
    const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const raw = []; let cur = null; let depth = 0;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { cur = { attendees: [], exdates: [] }; depth = 0; continue; }
      if (line === 'END:VEVENT') { if (cur) raw.push(cur); cur = null; continue; }
      if (!cur) continue;
      if (/^BEGIN:/.test(line)) { depth++; continue; } // skip VALARM etc.
      if (/^END:/.test(line)) { depth--; continue; }
      if (depth > 0) continue;
      const i = line.indexOf(':'); if (i < 0) continue;
      const [name, ...ps] = line.slice(0, i).split(';'); const value = line.slice(i + 1);
      const params = {}; for (const p of ps) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1); }
      const N = name.toUpperCase();
      if (N === 'ATTENDEE') cur.attendees.push({ email: value.replace(/^mailto:/i, '').toLowerCase(), partstat: (params.PARTSTAT || '').toUpperCase() });
      else if (N === 'EXDATE') value.split(',').forEach((v) => { const d = parseIcsDate(v, params); if (d) cur.exdates.push(toDate(d).getTime()); });
      else if (N === 'DTSTART' || N === 'DTEND' || N === 'RECURRENCE-ID') cur[N] = parseIcsDate(value, params);
      else if (N === 'ORGANIZER') cur.ORGANIZER = params.CN ? params.CN.replace(/^"|"$/g, '') : value.replace(/^mailto:/i, '');
      else cur[N] = value;
    }
    const me = String(myEmail || '').trim().toLowerCase();
    const mk = (r, start, end, suffix) => {
      const at = me && r.attendees.find((a) => a.email === me); const ps = at ? at.partstat : '';
      return { id: (r.UID || hash(String(r.SUMMARY) + start.getTime())) + suffix, uid: r.UID, title: unesc(r.SUMMARY) || '(no title)', start, end, allDay: !!(r.DTSTART && r.DTSTART.allDay), location: unesc(r.LOCATION),
        cancelled: (r.STATUS || '').toUpperCase() === 'CANCELLED', transparent: (r.TRANSP || '').toUpperCase() === 'TRANSPARENT', organizer: r.ORGANIZER,
        myStatus: ps === 'NEEDS-ACTION' ? 'needsAction' : ps === 'DECLINED' ? 'declined' : ps === 'TENTATIVE' ? 'tentative' : ps === 'ACCEPTED' ? 'accepted' : null, link: /^https?:/i.test(r.URL || '') ? r.URL : undefined };
    };
    const overrides = new Map();
    for (const r of raw) if (r['RECURRENCE-ID'] && r.UID) overrides.set(`${r.UID}|${toDate(r['RECURRENCE-ID']).getTime()}`, r);
    const out = [];
    for (const r of raw) {
      if (!r.DTSTART || r['RECURRENCE-ID']) continue;
      const s0 = toDate(r.DTSTART);
      let dur = r.DTEND ? toDate(r.DTEND) - s0 : r.DTSTART.allDay ? 86400e3 : 0;
      if (!r.DTEND && r.DURATION) { const m = /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(r.DURATION); if (m) dur = ((+m[1] || 0) * 604800 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000; }
      if (!r.RRULE) { const e = new Date(s0.getTime() + dur); if (e > from && s0 < to) out.push(mk(r, s0, e, '')); continue; }
      const rule = Object.fromEntries(r.RRULE.split(';').map((p) => p.split('=')).map(([k, v]) => [String(k).toUpperCase(), v]));
      const freq = rule.FREQ, interval = Math.max(1, +rule.INTERVAL || 1), count = +rule.COUNT || Infinity;
      const ud = rule.UNTIL ? parseIcsDate(rule.UNTIL) : null; const untilD = ud ? toDate(ud) : null;
      const byday = rule.BYDAY ? rule.BYDAY.split(',').map((d) => DAYS.indexOf(d.replace(/^[+-]?\d+/, ''))).filter((x) => x >= 0) : null;
      const ordinal = rule.BYDAY && /\d/.test(rule.BYDAY);
      const bymd = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : null;
      const w0 = r.DTSTART.w; const tz = r.DTSTART.allDay ? null : r.DTSTART.tz;
      const d0 = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d)); const dow0 = d0.getUTCDay();
      // fast-forward: with COUNT we must count from the start; otherwise jump close to the window
      let kStart = 0;
      if (count === Infinity) { const gap = Math.floor((from - s0) / 86400e3) - 400; if (gap > 0) kStart = gap - (gap % (freq === 'WEEKLY' ? 7 * interval : freq === 'DAILY' ? interval : 1)); }
      let n = 0;
      for (let k = kStart; k < kStart + 5000; k++) {
        const wd = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d + k));
        const w = { y: wd.getUTCFullYear(), mo: wd.getUTCMonth() + 1, d: wd.getUTCDate(), h: w0.h, mi: w0.mi, s: w0.s };
        const start = r.DTSTART.allDay ? new Date(w.y, w.mo - 1, w.d) : wallToDate(w, tz);
        if (start >= to || (untilD && start > untilD) || n >= count) break;
        const dow = wd.getUTCDay(); let ok = false;
        if (freq === 'DAILY') ok = k % interval === 0 && (!byday || byday.includes(dow));
        else if (freq === 'WEEKLY') ok = Math.floor((k + dow0) / 7) % interval === 0 && (byday ? byday.includes(dow) : dow === dow0);
        else if (freq === 'MONTHLY') { const months = (w.y - w0.y) * 12 + (w.mo - w0.mo); ok = months % interval === 0 && (bymd ? bymd.includes(w.d) : ordinal ? (() => { const m = /^([+-]?\d+)([A-Z]{2})$/.exec(rule.BYDAY.split(',')[0]); if (!m) return false; const nth = +m[1], dd = DAYS.indexOf(m[2]); if (dow !== dd) return false; if (nth > 0) return Math.ceil(w.d / 7) === nth; const dim = new Date(Date.UTC(w.y, w.mo, 0)).getUTCDate(); return Math.ceil((dim - w.d + 1) / 7) === -nth; })() : w.d === w0.d); }
        else if (freq === 'YEARLY') ok = (w.y - w0.y) % interval === 0 && w.mo === w0.mo && w.d === w0.d;
        if (!ok) continue;
        n++;
        if (r.exdates.includes(start.getTime())) continue;
        const ov = r.UID && overrides.get(`${r.UID}|${start.getTime()}`);
        if (ov) { if (ov.DTSTART) { const s1 = toDate(ov.DTSTART); const e1 = ov.DTEND ? toDate(ov.DTEND) : new Date(s1.getTime() + dur); if (e1 > from && s1 < to) out.push(mk({ ...r, ...ov, attendees: ov.attendees.length ? ov.attendees : r.attendees }, s1, e1, `@${start.getTime()}`)); } continue; }
        const end = new Date(start.getTime() + dur);
        if (end > from && start < to) out.push(mk(r, start, end, `@${start.getTime()}`));
      }
    }
    return out;
  }

  // ---------- RSS / Atom ----------
  function parseFeed(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror') || !(doc.querySelector('rss, feed, rdf\\:RDF, RDF'))) throw new FriendlyError('That link isn’t an RSS or Atom feed');
    const kid = (n, name) => [...n.children].find((c) => c.localName === name);
    const txt = (n, name) => { const x = kid(n, name); return x ? x.textContent.trim() : ''; };
    const chan = doc.querySelector('channel') || doc.documentElement;
    const title = txt(chan, 'title');
    const items = [...doc.getElementsByTagName('item')].map((it) => ({ title: strip(txt(it, 'title')), link: txt(it, 'link') || txt(it, 'guid'), date: txt(it, 'pubDate') || txt(it, 'date'), summary: strip(txt(it, 'description')) }));
    const entries = [...doc.getElementsByTagName('entry')].map((it) => { const ls = [...it.children].filter((c) => c.localName === 'link'); const l = ls.find((x) => (x.getAttribute('rel') || 'alternate') === 'alternate') || ls[0]; return { title: strip(txt(it, 'title')), link: l ? l.getAttribute('href') : '', date: txt(it, 'updated') || txt(it, 'published'), summary: strip(txt(it, 'summary') || txt(it, 'content')) }; });
    return { title, items: items.length ? items : entries };
  }
  // knownBlocked: publishers we know send no CORS headers, so skip the doomed direct request
  async function fetchFeed(url, useRelay, { knownBlocked = false } = {}) {
    let directErr = new FriendlyError(`${new URL(url).hostname} doesn’t let browser apps read its feed.`, { cors: true });
    if (!(knownBlocked && useRelay)) try { const r = await http(url, { json: false, service: new URL(url).hostname.replace(/^www\./, ''), timeout: 9000 }); return { ...parseFeed(await r.text()), via: 'direct' }; }
    catch (e) { directErr = e; }
    if (!useRelay || !CFG.rssRelay) throw directErr.cors ? new FriendlyError(`${new URL(url).hostname} doesn’t let browser apps read its feed. Turn on the feed relay to use it.`) : directErr;
    const j = await http(CFG.rssRelay + encodeURIComponent(url), { service: 'the feed relay (rss2json.com)', timeout: 12000 });
    if (!j || j.status !== 'ok') throw new FriendlyError(`The feed relay couldn’t read that feed${j && j.message ? ` (${clip(j.message, 80)})` : ''}`);
    return { title: (j.feed && j.feed.title) || '', items: (j.items || []).map((x) => ({ title: strip(x.title), link: x.link, date: x.pubDate, summary: strip(x.description) })), via: 'relay' };
  }
  M.parseICS = parseICS; M.parseFeed = parseFeed; M.fetchFeed = fetchFeed;
})();
