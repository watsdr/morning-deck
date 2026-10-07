// Network mocks for test/friends.js: token APIs (Todoist, GitHub, Google, Microsoft Graph), a fake GIS + MSAL,
// and an in-memory ntfy relay. Weather (Open-Meteo) and RSS are NOT mocked: the test hits them for real.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS' };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function times() {
  const now = new Date();
  const eod = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0);
  const a = new Date(Math.min(now.getTime() + 90 * 60000, eod.getTime() - 60 * 60000)); a.setSeconds(0, 0);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 15, 0);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return { now, a, aEnd: new Date(a.getTime() + 60 * 60000), b: new Date(a.getTime() + 30 * 60000), bEnd: new Date(a.getTime() + 75 * 60000), tomorrow, tomorrowEnd: new Date(tomorrow.getTime() + 45 * 60000), yesterday, today: ymd(now) };
}

const FAKE_GIS = `window.google = { accounts: { oauth2: {
  initTokenClient(cfg) { return { requestAccessToken() { (window.__gisCalls = window.__gisCalls || []).push(cfg.scope); setTimeout(() => cfg.callback({ access_token: 'fake-google-access', expires_in: 3599, scope: cfg.scope }), 60); } }; },
  revoke(t, cb) { cb && cb(); } } } };`;
const FAKE_MSAL = `window.msal = { PublicClientApplication: class {
  constructor(c) { window.__msalConfig = c; try { this.acct = JSON.parse(localStorage.getItem('msal.fake.account')); } catch (e) { this.acct = null; } }
  granted() { return new Set(JSON.parse(localStorage.getItem('msal.fake.granted') || '[]')); }
  grant(sc) { const g = this.granted(); sc.forEach((x) => g.add(x)); localStorage.setItem('msal.fake.granted', JSON.stringify([...g])); }
  async initialize() {}
  getActiveAccount() { return this.acct; } getAllAccounts() { return this.acct ? [this.acct] : []; }
  setActiveAccount(a) { this.acct = a; localStorage.setItem('msal.fake.account', JSON.stringify(a)); }
  async loginPopup(r) { (window.__msalCalls = window.__msalCalls || []).push(r.scopes.join(' ')); this.grant(r.scopes); return { account: { username: 'friend@example.com', homeAccountId: 'fake' }, accessToken: 'fake-ms-access' }; }
  async acquireTokenSilent(r) { const g = this.granted(); if (!this.acct || !r.scopes.every((x) => g.has(x))) throw new Error('interaction_required'); return { accessToken: 'fake-ms-access', account: this.acct }; }
  async acquireTokenPopup(r) { (window.__msalCalls = window.__msalCalls || []).push(r.scopes.join(' ')); this.grant(r.scopes); return { accessToken: 'fake-ms-access', account: this.acct }; }
  async clearCache() { this.acct = null; localStorage.removeItem('msal.fake.account'); } } };`;

async function install(ctx, log) {
  const T = times();
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const pre = (route) => (route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: CORS }) : null);
  const rec = (route) => { const r = route.request(); log.push({ method: r.method(), url: r.url(), body: r.postData(), auth: r.headers().authorization || '' }); };

  // ---- Todoist (API v1) ----
  await ctx.route('https://api.todoist.com/api/v1/**', (route) => {
    if (pre(route)) return; rec(route);
    const u = new URL(route.request().url()); const auth = route.request().headers().authorization;
    if (auth !== 'Bearer 0123456789abcdef0123456789abcdef01234567') return json(route, { error: 'Unauthorized' }, 401);
    if (u.pathname.endsWith('/user')) return json(route, { full_name: 'Test Friend', email: 'friend@example.com' });
    if (u.pathname.endsWith('/projects')) return json(route, { results: [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Work' }] });
    if (u.pathname.endsWith('/tasks/filter')) return json(route, { results: [
      { id: 't-overdue', content: 'Renew the car insurance', description: '', priority: 3, project_id: 'p1', due: { date: ymd(T.yesterday), is_recurring: false } },
      { id: 't-today', content: 'Send slides to [the team](https://example.com)', description: 'v2 deck', priority: 4, project_id: 'p2', due: { date: T.today, is_recurring: false } },
      { id: 't-recur', content: 'Water the plants', priority: 1, project_id: 'p1', due: { date: T.today, is_recurring: true, string: 'every day' } },
    ], next_cursor: null });
    if (/\/tasks\/[^/]+\/(close|reopen)$/.test(u.pathname)) return route.fulfill({ status: 204, headers: CORS });
    return json(route, { error: 'not mocked' }, 404);
  });

  // ---- GitHub ----
  await ctx.route('https://api.github.com/**', (route) => {
    if (pre(route)) return; rec(route);
    const u = new URL(route.request().url());
    if (!/^Bearer ghp_FAKEtoken/.test(route.request().headers().authorization || '')) return json(route, { message: 'Bad credentials' }, 401);
    if (u.pathname === '/user') return json(route, { login: 'test-friend' });
    if (u.pathname === '/notifications') return json(route, { message: 'Resource not accessible by personal access token' }, 403);
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q');
      if (q.includes('review-requested')) return json(route, { items: [{ id: 11, number: 42, title: 'Add dark mode toggle', html_url: 'https://github.com/example/app/pull/42', repository_url: 'https://api.github.com/repos/example/app', user: { login: 'contributor' }, updated_at: new Date(Date.now() - 3 * 3600e3).toISOString(), comments: 2, pull_request: {} }] });
      return json(route, { items: [{ id: 12, number: 7, title: 'Crash on empty config', html_url: 'https://github.com/example/app/issues/7', repository_url: 'https://api.github.com/repos/example/app', user: { login: 'reporter' }, updated_at: new Date(Date.now() - 26 * 3600e3).toISOString(), comments: 5 }] });
    }
    return json(route, { message: 'not mocked' }, 404);
  });

  // ---- ntfy (in-memory) ----
  const ntfy = { msgs: [] };
  ntfy.publish = (m) => { const msg = { id: 'n' + Math.random().toString(36).slice(2, 12), time: Math.floor(Date.now() / 1000), event: 'message', ...m }; ntfy.msgs.push(msg); return msg; };
  await ctx.route('https://ntfy.sh/**', async (route) => {
    if (pre(route)) return; rec(route);
    const r = route.request(); const u = new URL(r.url());
    if (r.method() === 'POST' && u.pathname === '/') { const b = JSON.parse(r.postData() || '{}'); const m = ntfy.publish({ topic: b.topic, title: b.title, message: b.message, priority: b.priority, tags: b.tags, click: b.click }); return json(route, m); }
    const mm = /^\/([\w-]+)\/json$/.exec(u.pathname);
    if (r.method() === 'GET' && mm) {
      const since = u.searchParams.get('since') || 'all'; let list = ntfy.msgs.filter((x) => x.topic === mm[1]);
      const idx = list.findIndex((x) => x.id === since); if (idx >= 0) list = list.slice(idx + 1);
      return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/x-ndjson' }, body: list.map((x) => JSON.stringify(x)).join('\n') + (list.length ? '\n' : '') });
    }
    return json(route, { error: 'not mocked' }, 404);
  });

  // ---- Google: GIS script + Calendar/Gmail/Tasks ----
  await ctx.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/javascript' }, body: FAKE_GIS }));
  const gEvent = { id: 'evC', summary: 'Quarterly planning', start: { dateTime: T.tomorrow.toISOString() }, end: { dateTime: T.tomorrowEnd.toISOString() }, htmlLink: 'https://calendar.google.com/event?eid=evC', organizer: { email: 'boss@example.com', displayName: 'A Manager' }, attendees: [{ email: 'boss@example.com', responseStatus: 'accepted' }, { email: 'friend@example.com', self: true, responseStatus: 'needsAction' }] };
  await ctx.route('https://www.googleapis.com/calendar/v3/**', (route) => {
    if (pre(route)) return; rec(route);
    const r = route.request(); const u = new URL(r.url());
    if (r.headers().authorization !== 'Bearer fake-google-access') return json(route, { error: { message: 'Invalid Credentials' } }, 401);
    if (u.pathname.endsWith('/events') && r.method() === 'GET') return json(route, { items: [
      { id: 'evA', summary: 'Team standup', start: { dateTime: T.a.toISOString() }, end: { dateTime: T.aEnd.toISOString() }, htmlLink: 'https://calendar.google.com/event?eid=evA', location: 'Room 2' },
      { id: 'evB', summary: 'Dentist', start: { dateTime: T.b.toISOString() }, end: { dateTime: T.bEnd.toISOString() }, htmlLink: 'https://calendar.google.com/event?eid=evB' },
      { id: 'evD', summary: 'Mom’s birthday', start: { date: T.today }, end: { date: ymd(new Date(T.now.getTime() + 86400e3)) }, transparency: 'transparent' },
      gEvent] });
    if (u.pathname.endsWith('/events/evC') && r.method() === 'GET') return json(route, gEvent);
    if (u.pathname.endsWith('/events/evC') && r.method() === 'PATCH') { const b = JSON.parse(r.postData()); gEvent.attendees = b.attendees; return json(route, gEvent); }
    return json(route, { error: 'not mocked' }, 404);
  });
  await ctx.route('https://gmail.googleapis.com/**', (route) => {
    if (pre(route)) return; rec(route);
    const r = route.request(); const u = new URL(r.url());
    if (u.pathname.endsWith('/messages') && r.method() === 'GET') return json(route, { messages: [{ id: 'm1', threadId: 't1' }] });
    if (u.pathname.endsWith('/messages/m1')) return json(route, { id: 'm1', threadId: 't1', labelIds: ['UNREAD', 'IMPORTANT', 'INBOX'], snippet: 'Your order has shipped and arrives Friday', internalDate: String(Date.now() - 2 * 3600e3), payload: { headers: [{ name: 'From', value: '"Example Shop" <orders@example.com>' }, { name: 'Subject', value: 'Your order is on its way' }] } });
    if (u.pathname.endsWith('/messages/m1/modify')) return json(route, { id: 'm1' });
    return json(route, { error: 'not mocked' }, 404);
  });
  await ctx.route('https://tasks.googleapis.com/**', (route) => {
    if (pre(route)) return; rec(route);
    const r = route.request(); const u = new URL(r.url());
    if (u.pathname.endsWith('/users/@me/lists')) return json(route, { items: [{ id: 'tl1', title: 'My Tasks' }] });
    if (u.pathname.endsWith('/lists/tl1/tasks')) return json(route, { items: [{ id: 'gt1', title: 'Book a dentist appointment', due: ymd(T.yesterday) + 'T00:00:00.000Z', status: 'needsAction' }] });
    if (u.pathname.endsWith('/lists/tl1/tasks/gt1')) return json(route, { id: 'gt1' });
    return json(route, { error: 'not mocked' }, 404);
  });

  // ---- Microsoft: fake MSAL + Graph ----
  await ctx.route('**/vendor/msal/msal-browser.min.js', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/javascript' }, body: FAKE_MSAL }));
  await ctx.route('https://graph.microsoft.com/**', (route) => {
    if (pre(route)) return; rec(route);
    const r = route.request(); const u = new URL(r.url()); const p = u.pathname.replace('/v1.0', '');
    if (r.headers().authorization !== 'Bearer fake-ms-access') return json(route, { error: { message: 'InvalidAuthenticationToken' } }, 401);
    if (p === '/me/mailFolders/inbox/messages') return json(route, { value: [
      { id: 'AAMkMSG1', subject: 'Contract needs your signature', from: { emailAddress: { name: 'Legal Team' } }, bodyPreview: 'Please sign by Friday so we can…', importance: 'high', inferenceClassification: 'focused', receivedDateTime: new Date(Date.now() - 3600e3).toISOString(), webLink: 'https://outlook.office.com/mail/id/AAMkMSG1' },
      { id: 'AAMkMSG2', subject: 'Newsletter', from: { emailAddress: { name: 'News' } }, bodyPreview: 'Weekly…', importance: 'normal', inferenceClassification: 'other', receivedDateTime: new Date().toISOString() }] });
    if (/^\/me\/messages\/[^/]+$/.test(p) && r.method() === 'PATCH') return json(route, { id: p.split('/').pop() });
    if (/^\/me\/messages\/[^/]+\/move$/.test(p)) return json(route, { id: JSON.parse(r.postData()).destinationId === 'archive' ? 'AAMkMSG1-archived' : 'AAMkMSG1' });
    if (p === '/me/calendarView') return json(route, { value: [
      { id: 'msEv1', subject: 'Project sync', start: { dateTime: T.a.toISOString().replace('Z', '0000') }, end: { dateTime: T.aEnd.toISOString().replace('Z', '0000') }, isAllDay: false, responseStatus: { response: 'accepted' }, showAs: 'busy', isCancelled: false, isOrganizer: false, organizer: { emailAddress: { name: 'Coworker' } }, webLink: 'https://outlook.office.com/calendar/item/msEv1' },
      { id: 'msEv2', subject: 'Offsite lunch', start: { dateTime: T.tomorrow.toISOString().replace('Z', '0000') }, end: { dateTime: T.tomorrowEnd.toISOString().replace('Z', '0000') }, isAllDay: false, responseStatus: { response: 'notResponded' }, showAs: 'tentative', isCancelled: false, isOrganizer: false, organizer: { emailAddress: { name: 'Coworker' } } }] });
    if (/^\/me\/events\/[^/]+\/(accept|tentativelyAccept)$/.test(p)) return route.fulfill({ status: 202, headers: CORS });
    if (p === '/me/todo/lists') return json(route, { value: [{ id: 'L1', displayName: 'Tasks' }] });
    if (p === '/me/todo/lists/L1/tasks') return json(route, { value: [{ id: 'T1', title: 'Pay rent', importance: 'high', status: 'notStarted', dueDateTime: { dateTime: T.today + 'T00:00:00.0000000', timeZone: 'UTC' } }] });
    if (p === '/me/todo/lists/L1/tasks/T1') return json(route, { id: 'T1' });
    return json(route, { error: { message: 'not mocked ' + p } }, 404);
  });
  return { ntfy, T };
}

function icsSample() {
  const T = times();
  const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = T.today.replace(/-/g, '');
  const weekAgo = new Date(T.a.getTime() - 7 * 86400e3);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
    'BEGIN:VEVENT', 'UID:ics-a', `DTSTART:${f(T.a)}`, `DTEND:${f(T.aEnd)}`, 'SUMMARY:Design review', 'LOCATION:Room 4', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:ics-b', `DTSTART:${f(T.b)}`, `DTEND:${f(T.bEnd)}`, 'SUMMARY:School pickup', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:ics-weekly', `DTSTART:${f(weekAgo).slice(0, 9)}070000Z`, `DTEND:${f(weekAgo).slice(0, 9)}073000Z`, 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly run club', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:ics-allday', `DTSTART;VALUE=DATE:${day}`, 'SUMMARY:Bin day', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:ics-invite', `DTSTART:${f(T.tomorrow)}`, `DTEND:${f(T.tomorrowEnd)}`, 'SUMMARY:Book club', 'ORGANIZER;CN=Pat:mailto:pat@example.com',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:pat@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Me:mailto:me@example.com', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n') + '\r\n';
}
module.exports = { install, icsSample, times, CORS };
