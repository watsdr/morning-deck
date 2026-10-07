/* Morning Deck for Friends — connectors. Each one runs in this browser and talks straight to the service.
 * Tokens stay in this browser's storage. Default: swipes only record locally. With "Let swipes act" on,
 * only simple, reversible actions run (complete/reopen a task, mark read/unread, archive/move back, RSVP). */
(() => {
  'use strict';
  const M = window.MDF; const CFG = M.CFG;
  const { FriendlyError, http, clip, strip, fmtTime, fmtDay, relIn, ymd, startOfDay, addDays } = M;

  // tiny DOM helper (also used by ui.js)
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  M.h = h;
  const needsAuth = (svc, msg) => new FriendlyError(msg || `Sign in to ${svc} again to refresh today’s cards`, { needsAuth: true });
  const needsSetup = (who) => new FriendlyError(`${who} sign-in needs a one-time setup by the person who shared this app (see docs/FRIENDS-OWNER-SETUP.md).`, { needsSetup: true });
  const hash = (s) => { let x = 5381; for (const c of String(s)) x = ((x << 5) + x + c.charCodeAt(0)) >>> 0; return x.toString(36); };
  const until = (d) => Math.max(0, Math.round((d - Date.now()) / 60000));

  // ======================= shared: Google (GIS token model) =======================
  const G_BASE = 'https://www.googleapis.com/auth/';
  const google = {
    configured: () => !!CFG.googleClientId,
    preload() { if (google.configured()) M.loadScript('https://accounts.google.com/gsi/client').catch(() => {}); },
    saved: () => M.ls.get('auth.google', null),
    has(scopes) { const t = google.saved(); if (!t || Date.now() > t.expires_at - 60000) return false; const g = (t.scope || '').split(' '); return scopes.every((s) => g.includes(s)); },
    neededScopes(extra = []) {
      const s = M.settings(); const out = new Set(extra);
      for (const [id, st] of Object.entries(s.services)) { const d = M.services.get(id); if (!d || d.provider !== 'google' || st.on === false) continue; d.scopes.forEach((x) => out.add(x)); if (st.act && d.actScopes) d.actScopes.forEach((x) => out.add(x)); }
      return [...out];
    },
    // interactive: must run inside a tap (opens Google's consent popup; closes by itself once already granted)
    async signIn(scopes) {
      if (!google.configured()) throw needsSetup('Google');
      await M.loadScript('https://accounts.google.com/gsi/client');
      const want = google.neededScopes(scopes);
      const r = await new Promise((res, rej) => {
        const c = window.google.accounts.oauth2.initTokenClient({
          client_id: CFG.googleClientId, scope: want.join(' '), include_granted_scopes: true,
          callback: (t) => (t && t.error ? rej(new FriendlyError(`Google said: ${t.error_description || t.error}`)) : res(t)),
          error_callback: (e) => rej(new FriendlyError(e && e.type === 'popup_closed' ? 'The Google window was closed before finishing.' : e && e.type === 'popup_failed_to_open' ? 'Your browser blocked the Google window. Allow pop-ups for this site and try again.' : `Google sign-in failed (${(e && (e.message || e.type)) || 'unknown'})`)),
        });
        c.requestAccessToken({ prompt: '' });
      });
      const granted = (r.scope || '').split(' ');
      const missing = scopes.filter((x) => !granted.includes(x));
      M.ls.set('auth.google', { access_token: r.access_token, expires_at: Date.now() + (Number(r.expires_in) || 3599) * 1000, scope: r.scope || '' });
      if (missing.length) throw new FriendlyError(`Google didn’t grant: ${missing.map((x) => x.replace(G_BASE, '')).join(', ')}. Tick every box on the consent screen.`);
      return r.access_token;
    },
    async token(scopes) { if (!google.configured()) throw needsSetup('Google'); if (!google.has(scopes)) throw needsAuth('Google', 'Google sign-ins last an hour. Tap to refresh Google'); return google.saved().access_token; },
    async api(url, opts = {}, scopes) {
      const t = await google.token(scopes);
      try { return await http(url, { ...opts, service: 'Google', headers: { Authorization: `Bearer ${t}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } }); }
      catch (e) { if (e.status === 401) { M.ls.del('auth.google'); throw needsAuth('Google'); } throw e; }
    },
    signOut() { const t = google.saved(); M.ls.del('auth.google'); try { if (t && window.google && window.google.accounts) window.google.accounts.oauth2.revoke(t.access_token, () => {}); } catch (_) {} },
  };

  // ======================= shared: Microsoft (MSAL.js, SPA + PKCE) =======================
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  let pcaP = null;
  const ms = {
    configured: () => !!CFG.microsoftClientId,
    preload() { if (ms.configured()) M.loadScript('vendor/msal/msal-browser.min.js').catch(() => {}); },
    async app() {
      if (!ms.configured()) throw needsSetup('Microsoft');
      await M.loadScript('vendor/msal/msal-browser.min.js');
      if (!pcaP) pcaP = (async () => {
        const pca = new window.msal.PublicClientApplication({
          auth: { clientId: CFG.microsoftClientId, authority: 'https://login.microsoftonline.com/common', redirectUri: new URL('auth/ms-redirect.html', location.href).href },
          cache: { cacheLocation: 'localStorage' },
        });
        await pca.initialize();
        return pca;
      })().catch((e) => { pcaP = null; throw e; });
      return pcaP;
    },
    account(pca) { const a = pca.getActiveAccount() || pca.getAllAccounts()[0] || null; if (a) pca.setActiveAccount(a); return a; },
    neededScopes(extra = []) {
      const s = M.settings(); const out = new Set(['User.Read', ...extra]);
      for (const [id, st] of Object.entries(s.services)) { const d = M.services.get(id); if (!d || d.provider !== 'microsoft' || st.on === false) continue; d.scopes.forEach((x) => out.add(x)); if (st.act && d.actScopes) d.actScopes.forEach((x) => out.add(x)); }
      return [...out];
    },
    async signIn(scopes) { // interactive (inside a tap)
      const pca = await ms.app(); const want = ms.neededScopes(scopes); let acct = ms.account(pca);
      try {
        if (!acct) { const r = await pca.loginPopup({ scopes: want, prompt: 'select_account' }); pca.setActiveAccount(r.account); return r.accessToken; }
        try { return (await pca.acquireTokenSilent({ scopes: want, account: acct })).accessToken; }
        catch (_) { const r = await pca.acquireTokenPopup({ scopes: want, account: acct }); pca.setActiveAccount(r.account); return r.accessToken; }
      } catch (e) {
        const code = (e && (e.errorCode || e.name)) || '';
        throw new FriendlyError(/user_cancelled|popup_window/i.test(code) ? 'The Microsoft window was closed or blocked. Allow pop-ups for this site and try again.' : `Microsoft sign-in failed (${clip((e && (e.errorMessage || e.message)) || code, 140)})`);
      }
    },
    async token(scopes) {
      const pca = await ms.app(); const acct = ms.account(pca);
      if (!acct) throw needsAuth('Microsoft', 'Tap to sign in to Microsoft again');
      try { return (await pca.acquireTokenSilent({ scopes, account: acct })).accessToken; }
      catch (_) { throw needsAuth('Microsoft', 'Microsoft wants you to sign in again. Tap to refresh'); }
    },
    async api(path, opts = {}, scopes) {
      const t = await ms.token(scopes);
      try { return await http(path.startsWith('http') ? path : GRAPH + path, { ...opts, service: 'Microsoft', headers: { Authorization: `Bearer ${t}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } }); }
      catch (e) { if (e.status === 401) throw needsAuth('Microsoft'); throw e; }
    },
    async signOut() { try { const pca = await ms.app(); const a = ms.account(pca); if (a) await pca.clearCache({ account: a }); } catch (_) {} },
  };
  M.google = google; M.ms = ms;

  const reauthCard = (svcName, provider) => () => ({
    id: `reauth-${provider}-${M.deckDay()}`, source: svcName, emoji: '🔑', color: '#ffaa1f', type: 'question', priority: 'high', urgency: 0, chip: 'Sign-in needed',
    title: `Refresh ${provider === 'google' ? 'Google' : 'Microsoft'} to see today’s ${svcName} cards`,
    body: provider === 'google' ? 'Google sign-ins in browser apps last an hour, so Morning Deck asks once per session. It’s one tap.' : 'Microsoft asked you to sign in again (this happens every day or so for browser apps).',
    gestures: { right: { label: 'Refresh', value: 'reauth', action: 'reauth' }, left: { label: 'Not now', value: 'not_now' } },
  });
  const reauthAction = (provider) => ({ local: true, run: () => { M.emit('mdf:reauth', { provider }); return true; } });

  // ======================= calendar cards (ICS, Google, Microsoft) =======================
  function calendarCards(events, { svc, source, emoji, color, rsvp }) {
    const now = new Date(); const sod = startOfDay(now); const eod = addDays(sod, 1);
    const live = events.filter((e) => !e.cancelled && e.myStatus !== 'declined');
    const today = live.filter((e) => e.start < eod && e.end > sod).sort((a, b) => a.start - b.start);
    const timed = today.filter((e) => !e.allDay);
    const allDay = today.filter((e) => e.allDay);
    const cards = [];
    const agenda = today.map((e) => `${e.allDay ? 'All day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`}  ${e.title}${e.location ? ` · ${e.location}` : ''}${e.myStatus === 'needsAction' ? '  (not answered)' : ''}`).join('\n');
    const base = { source, emoji, color, service: svc, type: 'info' };
    const next = timed.find((e) => e.end > now);
    if (next) {
      const first = next === timed[0];
      const m = until(next.start);
      cards.push({ ...base, id: `${svc}-next-${hash(next.id + next.start.toISOString())}`, chip: first ? 'First meeting' : 'Next up', priority: m <= 30 ? 'high' : 'normal', urgency: Math.min(99, Math.round(m / 6)),
        title: `${next.start <= now ? 'Now' : first ? 'First up' : 'Next'}: ${next.title}`, body: `${fmtTime(next.start)}–${fmtTime(next.end)} · ${next.start <= now ? 'happening now' : relIn(next.start)}${next.location ? ` · ${clip(next.location, 60)}` : ''}${timed.length > 1 ? ` · ${timed.length} timed events today` : ''}`,
        details: `TODAY\n${agenda}`, link: next.link, gestures: { right: { label: 'Got it', value: 'ack' } } });
    }
    // conflicts: overlapping busy events today
    const busy = timed.filter((e) => !e.transparent && e.end > now);
    const seenPair = new Set();
    for (let i = 0; i < busy.length && cards.filter((c) => c.chip === 'Conflict').length < 3; i++) {
      for (let j = i + 1; j < busy.length; j++) {
        const a = busy[i], b = busy[j];
        if (b.start >= a.end) continue;
        const k = [a.id, b.id].sort().join('|'); if (seenPair.has(k)) continue; seenPair.add(k);
        const os = new Date(Math.max(a.start, b.start)), oe = new Date(Math.min(a.end, b.end));
        cards.push({ ...base, id: `${svc}-conflict-${hash(k)}-${ymd(sod)}`, emoji: '⚠️', color: '#ff8a3d', chip: 'Conflict', priority: 'high', urgency: Math.min(99, Math.round(until(os) / 10)),
          title: `Two things at ${fmtTime(os)} today`, body: `“${clip(a.title, 50)}” overlaps “${clip(b.title, 50)}” (${fmtTime(os)}–${fmtTime(oe)}). Something has to move.`,
          details: `${fmtTime(a.start)}–${fmtTime(a.end)}  ${a.title}\n${fmtTime(b.start)}–${fmtTime(b.end)}  ${b.title}`, link: a.link, gestures: { right: { label: 'Got it', value: 'ack' }, left: { label: 'It’s fine', value: 'fine' } } });
        break;
      }
    }
    if (allDay.length) cards.push({ ...base, id: `${svc}-allday-${ymd(sod)}`, chip: 'All day', priority: 'low', urgency: 70,
      title: `Today: ${clip(allDay.map((e) => e.title).join(', '), 90)}`, body: `${allDay.length} all-day item${allDay.length > 1 ? 's' : ''} on your calendar.`, details: `TODAY\n${agenda}`, gestures: { right: { label: 'Got it', value: 'ack' } } });
    // invites waiting for an answer (next 7 days)
    const horizon = addDays(sod, 8);
    for (const e of live.filter((x) => x.myStatus === 'needsAction' && x.end > now && x.start < horizon).sort((a, b) => a.start - b.start).slice(0, 5)) {
      const soon = e.start - now < 36 * 3600e3;
      cards.push({ ...base, type: 'question', id: `${svc}-rsvp-${hash(e.id)}`, emoji: '📨', chip: 'RSVP needed', priority: soon ? 'high' : 'normal', urgency: Math.min(99, Math.round(until(e.start) / 60)),
        title: `RSVP: ${e.title}`, body: `${e.allDay ? fmtDay(e.start) + ' · all day' : `${fmtDay(e.start)} · ${fmtTime(e.start)}–${fmtTime(e.end)}`}${e.organizer ? ` · from ${clip(e.organizer, 40)}` : ''}${e.location ? ` · ${clip(e.location, 40)}` : ''}`,
        details: rsvp ? rsvp.note : 'Your answer is recorded on this phone. Answer the invite in your calendar app.', link: e.link, ref: e.ref,
        gestures: { right: { label: 'Accept', value: 'accept', action: rsvp && rsvp.accept }, left: { label: 'Decline', value: 'decline', action: rsvp && rsvp.decline }, up: { label: 'Later', value: 'snooze', snooze: true } } });
    }
    return cards;
  }
  M.calendarCards = calendarCards;
  M.svcKit = { h, needsAuth, needsSetup, hash, until, google, ms, reauthCard, reauthAction, G_BASE };
})();
