/* Morning Deck for Friends — Google (Calendar, Gmail, Tasks) and Microsoft (Outlook mail & calendar, To Do).
 * They need the app owner's one-time client IDs in config.js; without them each shows “needs setup”. */
(() => {
  'use strict';
  const M = window.MDF;
  const { clip, strip, relIn, ymd, startOfDay, addDays } = M;
  const { google, ms, reauthCard, reauthAction, G_BASE } = M.svcKit;
  const R = M.registerService;

  const common = (provider) => ({
    provider, status: 'oauth', oauth: true,
    needsSetup: () => (provider === 'google' ? !google.configured() : !ms.configured()),
    reauthCard: reauthCard(provider === 'google' ? 'Google' : 'Microsoft', provider),
    connect() { return provider === 'google' ? google.signIn(this.scopes) : ms.signIn(this.scopes); },
    enableAct() { return provider === 'google' ? google.signIn([...this.scopes, ...(this.actScopes || [])]) : ms.signIn([...this.scopes, ...(this.actScopes || [])]); },
  });

  // ---------- Google Calendar ----------
  const GCAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  async function gEvents() {
    const sod = startOfDay(new Date());
    const j = await google.api(`${GCAL}?singleEvents=true&orderBy=startTime&maxResults=100&timeMin=${encodeURIComponent(sod.toISOString())}&timeMax=${encodeURIComponent(addDays(sod, 8).toISOString())}`, {}, [G_BASE + 'calendar.readonly']);
    return (j.items || []).map((e) => {
      const allDay = !!(e.start && e.start.date);
      const me = (e.attendees || []).find((a) => a.self); const rs = me ? me.responseStatus : null;
      return { id: e.id, title: e.summary || '(no title)', allDay, location: e.location, link: e.htmlLink, cancelled: e.status === 'cancelled', transparent: e.transparency === 'transparent',
        start: allDay ? new Date(e.start.date + 'T00:00:00') : new Date(e.start.dateTime), end: allDay ? new Date(e.end.date + 'T00:00:00') : new Date(e.end.dateTime),
        organizer: e.organizer && !e.organizer.self ? (e.organizer.displayName || e.organizer.email) : '', myStatus: rs, ref: { eventId: e.id } };
    });
  }
  async function gSetRsvp(eventId, status) {
    const url = `${GCAL}/${encodeURIComponent(eventId)}`; const sc = [G_BASE + 'calendar.events'];
    const ev = await google.api(url, {}, sc);
    const prev = ((ev.attendees || []).find((a) => a.self) || {}).responseStatus || 'needsAction';
    await google.api(`${url}?sendUpdates=none`, { method: 'PATCH', body: JSON.stringify({ attendees: (ev.attendees || []).map((a) => (a.self ? { ...a, responseStatus: status } : a)) }) }, sc);
    return { eventId, prev };
  }
  const gUndo = (c, r) => gSetRsvp(r.eventId, r.prev);
  R({
    ...common('google'), id: 'gcal', name: 'Google Calendar', category: 'Calendar', emoji: '📅', color: '#4285f4',
    blurb: 'First meeting, conflicts, all-day items, invites to answer. Optional: RSVP with a swipe.',
    privacy: 'Read-only access to your calendar. The sign-in token stays in this browser (it lasts an hour) and only talks to Google.',
    scopes: [G_BASE + 'calendar.readonly'], actScopes: [G_BASE + 'calendar.events'], canAct: true,
    actHelp: 'Accept/Decline sets your RSVP on the invite without emailing anyone (sendUpdates=none). Undo puts your previous answer back.',
    async fetch() {
      const st = M.svcState('gcal') || {};
      return M.calendarCards(await gEvents(), { svc: 'gcal', source: 'Google Calendar', emoji: '📅', color: '#4285f4', rsvp: { accept: 'accept', decline: 'decline', note: st.act ? 'Swiping Accept/Decline answers the invite in Google Calendar (no email is sent). Undo restores your previous answer.' : 'Your answer is recorded on this phone. Turn on “Let swipes act” in Settings to answer invites with a swipe.' } });
    },
    actions: { accept: { run: (c) => gSetRsvp(c.ref.eventId, 'accepted'), undo: gUndo }, decline: { run: (c) => gSetRsvp(c.ref.eventId, 'declined'), undo: gUndo }, reauth: reauthAction('google') },
  });

  // ---------- Gmail ----------
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const gmMod = (id, body) => google.api(`${GMAIL}/messages/${id}/modify`, { method: 'POST', body: JSON.stringify(body) }, [G_BASE + 'gmail.modify']);
  R({
    ...common('google'), id: 'gmail', name: 'Gmail', category: 'Email', emoji: '✉️', color: '#ea4335',
    blurb: 'Important unread mail from the last 3 days. Optional: archive or mark read with a swipe.',
    privacy: 'Read-only access to subjects, senders and snippets. Nothing is ever sent or deleted. The token stays in this browser and only talks to Google.',
    scopes: [G_BASE + 'gmail.readonly'], actScopes: [G_BASE + 'gmail.modify'], canAct: true,
    actHelp: 'Right = Archive (out of the inbox, marked read), Left = Mark read. Undo puts the message back. Morning Deck never sends, replies or deletes.',
    async fetch() {
      const sc = [G_BASE + 'gmail.readonly'];
      const list = await google.api(`${GMAIL}/messages?maxResults=10&q=${encodeURIComponent('is:unread is:important in:inbox newer_than:3d')}`, {}, sc);
      const msgs = await Promise.all((list.messages || []).map((m) => google.api(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, {}, sc).catch(() => null)));
      return msgs.filter(Boolean).map((m) => {
        const hd = Object.fromEntries(((m.payload && m.payload.headers) || []).map((x) => [x.name.toLowerCase(), x.value]));
        const from = (hd.from || '').replace(/\s*<[^>]+>/, '').replace(/"/g, '') || hd.from || 'someone';
        const at = new Date(+m.internalDate || Date.now());
        return { id: `gmail-${m.id}`, source: 'Gmail', emoji: '✉️', color: '#ea4335', type: 'question', priority: (m.labelIds || []).includes('STARRED') ? 'high' : 'normal', urgency: 30 + Math.min(40, Math.round((Date.now() - at) / 3600e3)),
          chip: 'Important · unread', meta: relIn(at), title: clip(hd.subject || '(no subject)', 140), body: `From ${clip(from, 50)} · ${clip(strip(m.snippet), 170)}`, ref: { id: m.id },
          link: `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`, linkLabel: 'Open in Gmail ↗',
          gestures: { right: { label: 'Archive', value: 'archive', action: 'archive' }, left: { label: 'Mark read', value: 'mark_read', action: 'markRead' }, up: { label: 'Later', value: 'snooze', snooze: true } } };
      });
    },
    actions: {
      archive: { run: async (c) => { await gmMod(c.ref.id, { removeLabelIds: ['INBOX', 'UNREAD'] }); return { id: c.ref.id }; }, undo: (c, r) => gmMod(r.id, { addLabelIds: ['INBOX', 'UNREAD'] }) },
      markRead: { run: async (c) => { await gmMod(c.ref.id, { removeLabelIds: ['UNREAD'] }); return { id: c.ref.id }; }, undo: (c, r) => gmMod(r.id, { addLabelIds: ['UNREAD'] }) },
      reauth: reauthAction('google'),
    },
  });

  // ---------- Google Tasks ----------
  const GT = 'https://tasks.googleapis.com/tasks/v1';
  R({
    ...common('google'), id: 'gtasks', name: 'Google Tasks', category: 'Tasks', emoji: '☑️', color: '#1a73e8',
    blurb: 'Overdue and due-today tasks from all your lists. Optional: complete with a swipe.',
    privacy: 'Read-only access to your tasks. The token stays in this browser and only talks to Google.',
    scopes: [G_BASE + 'tasks.readonly'], actScopes: [G_BASE + 'tasks'], canAct: true, actHelp: 'Right = Done marks the task completed. Undo un-completes it.',
    async fetch() {
      const sc = [G_BASE + 'tasks.readonly']; const today = ymd(new Date());
      const lists = await google.api(`${GT}/users/@me/lists?maxResults=20`, {}, sc);
      const dueMax = new Date(today + 'T23:59:59Z').toISOString();
      const per = await Promise.all((lists.items || []).slice(0, 8).map((l) => google.api(`${GT}/lists/${l.id}/tasks?showCompleted=false&showHidden=false&maxResults=50&dueMax=${encodeURIComponent(dueMax)}`, {}, sc).then((j) => (j.items || []).map((t) => ({ ...t, list: l })))));
      return per.flat().filter((t) => t.due && t.title).slice(0, 20).map((t) => {
        const dd = t.due.slice(0, 10); const overdue = dd < today; const days = overdue ? Math.round((new Date(today) - new Date(dd)) / 86400e3) : 0;
        return { id: `gtasks-${t.id}-${dd}`, source: 'Google Tasks', emoji: '☑️', color: '#1a73e8', type: 'question', priority: overdue ? 'high' : 'normal', urgency: overdue ? Math.max(0, 10 - days) : 30,
          chip: overdue ? `Overdue ${days} day${days > 1 ? 's' : ''}` : 'Due today', title: clip(t.title, 140), body: [t.list.title, t.notes && clip(t.notes, 140)].filter(Boolean).join(' · '), ref: { list: t.list.id, id: t.id },
          link: t.webViewLink, gestures: { right: { label: 'Done', value: 'done', action: 'complete' }, left: { label: 'Not today', value: 'not_today' } } };
      });
    },
    actions: {
      complete: { run: async (c) => { await google.api(`${GT}/lists/${c.ref.list}/tasks/${c.ref.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) }, [G_BASE + 'tasks']); return c.ref; },
        undo: (c, r) => google.api(`${GT}/lists/${r.list}/tasks/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'needsAction', completed: null }) }, [G_BASE + 'tasks']) },
      reauth: reauthAction('google'),
    },
  });

  // ---------- Outlook mail ----------
  const RW = ['Mail.ReadWrite'];
  R({
    ...common('microsoft'), id: 'outlook', name: 'Outlook mail', category: 'Email', emoji: '📧', color: '#0a64ad',
    blurb: 'Unread high-importance or Focused mail from the last 3 days (personal, work or school accounts).',
    privacy: 'Read-only access to your mail. Microsoft handles the sign-in (MSAL), and tokens stay in this browser.',
    scopes: ['Mail.Read'], actScopes: RW, canAct: true,
    actHelp: 'Right = Archive (moves it to Archive and marks it read), Left = Mark read. Undo moves it back and marks it unread. Never sends or deletes.',
    async fetch() {
      const since = new Date(Date.now() - 3 * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
      const j = await ms.api(`/me/mailFolders/inbox/messages?$top=30&$select=id,subject,from,bodyPreview,importance,inferenceClassification,receivedDateTime,webLink,flag&$filter=${encodeURIComponent(`receivedDateTime ge ${since} and isRead eq false`)}&$orderby=${encodeURIComponent('receivedDateTime desc')}`, {}, ['Mail.Read']);
      return (j.value || []).filter((m) => m.importance === 'high' || m.inferenceClassification === 'focused').slice(0, 10).map((m) => {
        const at = new Date(m.receivedDateTime);
        const who = (m.from && m.from.emailAddress && (m.from.emailAddress.name || m.from.emailAddress.address)) || 'someone';
        return { id: `outlook-${m.id.slice(-40)}`, source: 'Outlook', emoji: '📧', color: '#0a64ad', type: 'question', priority: m.importance === 'high' || (m.flag && m.flag.flagStatus === 'flagged') ? 'high' : 'normal', urgency: 30 + Math.min(40, Math.round((Date.now() - at) / 3600e3)),
          chip: m.importance === 'high' ? 'High importance' : 'Focused · unread', meta: relIn(at), title: clip(m.subject || '(no subject)', 140), body: `From ${clip(who, 50)} · ${clip(m.bodyPreview, 170)}`,
          ref: { id: m.id }, link: m.webLink, linkLabel: 'Open in Outlook ↗',
          gestures: { right: { label: 'Archive', value: 'archive', action: 'archive' }, left: { label: 'Mark read', value: 'mark_read', action: 'markRead' }, up: { label: 'Later', value: 'snooze', snooze: true } } };
      });
    },
    actions: {
      markRead: { run: async (c) => { await ms.api(`/me/messages/${c.ref.id}`, { method: 'PATCH', body: JSON.stringify({ isRead: true }) }, RW); return { id: c.ref.id }; }, undo: (c, r) => ms.api(`/me/messages/${r.id}`, { method: 'PATCH', body: JSON.stringify({ isRead: false }) }, RW) },
      archive: { run: async (c) => { await ms.api(`/me/messages/${c.ref.id}`, { method: 'PATCH', body: JSON.stringify({ isRead: true }) }, RW); const m = await ms.api(`/me/messages/${c.ref.id}/move`, { method: 'POST', body: JSON.stringify({ destinationId: 'archive' }) }, RW); return { id: m.id }; },
        undo: async (c, r) => { const m = await ms.api(`/me/messages/${r.id}/move`, { method: 'POST', body: JSON.stringify({ destinationId: 'inbox' }) }, RW); await ms.api(`/me/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ isRead: false }) }, RW); } },
      reauth: reauthAction('microsoft'),
    },
  });

  // ---------- Outlook calendar ----------
  R({
    ...common('microsoft'), id: 'mscal', name: 'Outlook calendar', category: 'Calendar', emoji: '📆', color: '#0f6cbd',
    blurb: 'First meeting, conflicts, all-day items, invites to answer (personal, work or school).',
    privacy: 'Read-only access to your calendar. Tokens stay in this browser and only talk to Microsoft.',
    scopes: ['Calendars.Read'], actScopes: ['Calendars.ReadWrite'], canAct: true,
    actHelp: 'Accept answers the invite without emailing the organizer, and Undo switches it to Tentative (Outlook can’t go back to “not answered”). Decline is only recorded, because declining in Outlook moves the invite to Deleted Items.',
    async fetch() {
      const st = M.svcState('mscal') || {}; const sod = startOfDay(new Date());
      const j = await ms.api(`/me/calendarView?startDateTime=${encodeURIComponent(sod.toISOString())}&endDateTime=${encodeURIComponent(addDays(sod, 8).toISOString())}&$top=100&$orderby=start/dateTime&$select=id,subject,start,end,isAllDay,location,responseStatus,showAs,isCancelled,webLink,organizer,isOrganizer`, { headers: { Prefer: 'outlook.timezone="UTC"' } }, ['Calendars.Read']);
      const ev = (j.value || []).map((e) => {
        const sd = e.start.dateTime.slice(0, 19), ed = e.end.dateTime.slice(0, 19); const r = (e.responseStatus || {}).response;
        return { id: e.id, title: e.subject || '(no title)', allDay: e.isAllDay, location: e.location && e.location.displayName, link: e.webLink, cancelled: e.isCancelled, transparent: e.showAs === 'free',
          start: e.isAllDay ? new Date(sd.slice(0, 10) + 'T00:00:00') : new Date(sd + 'Z'), end: e.isAllDay ? new Date(ed.slice(0, 10) + 'T00:00:00') : new Date(ed + 'Z'),
          organizer: e.isOrganizer ? '' : (e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.name) || '',
          myStatus: e.isOrganizer ? 'accepted' : r === 'notResponded' || r === 'none' ? 'needsAction' : r === 'declined' ? 'declined' : r === 'tentativelyAccepted' ? 'tentative' : 'accepted', ref: { eventId: e.id } };
      });
      return M.calendarCards(ev, { svc: 'mscal', source: 'Outlook calendar', emoji: '📆', color: '#0f6cbd', rsvp: { accept: 'accept', decline: undefined, note: st.act ? 'Accept answers the invite in Outlook without emailing the organizer, and Undo sets it to Tentative. Decline is only recorded.' : 'Your answer is recorded on this phone. Turn on “Let swipes act” in Settings to accept invites with a swipe.' } });
    },
    actions: {
      accept: { run: async (c) => { await ms.api(`/me/events/${c.ref.eventId}/accept`, { method: 'POST', body: JSON.stringify({ sendResponse: false }), json: false }, ['Calendars.ReadWrite']); return { eventId: c.ref.eventId }; },
        undo: (c, r) => ms.api(`/me/events/${r.eventId}/tentativelyAccept`, { method: 'POST', body: JSON.stringify({ sendResponse: false }), json: false }, ['Calendars.ReadWrite']) },
      reauth: reauthAction('microsoft'),
    },
  });

  // ---------- Microsoft To Do ----------
  R({
    ...common('microsoft'), id: 'mstodo', name: 'Microsoft To Do', category: 'Tasks', emoji: '🔵', color: '#2564cf',
    blurb: 'Overdue and due-today tasks from your lists. Optional: complete with a swipe.',
    privacy: 'Read-only access to your tasks. Tokens stay in this browser and only talk to Microsoft.',
    scopes: ['Tasks.Read'], actScopes: ['Tasks.ReadWrite'], canAct: true, actHelp: 'Right = Done completes the task. Undo sets it back to not started.',
    async fetch() {
      const today = ymd(new Date());
      const lists = await ms.api('/me/todo/lists?$top=20', {}, ['Tasks.Read']);
      const per = await Promise.all((lists.value || []).slice(0, 8).map((l) => ms.api(`/me/todo/lists/${l.id}/tasks?$top=50&$filter=${encodeURIComponent("status ne 'completed'")}`, {}, ['Tasks.Read']).then((j) => (j.value || []).map((t) => ({ ...t, list: l }))).catch(() => [])));
      return per.flat().filter((t) => t.dueDateTime && t.dueDateTime.dateTime.slice(0, 10) <= today).slice(0, 20).map((t) => {
        const dd = t.dueDateTime.dateTime.slice(0, 10); const overdue = dd < today; const days = overdue ? Math.round((new Date(today) - new Date(dd)) / 86400e3) : 0;
        return { id: `mstodo-${t.id.slice(-40)}-${dd}`, source: 'To Do', emoji: '🔵', color: '#2564cf', type: 'question', priority: overdue || t.importance === 'high' ? 'high' : 'normal', urgency: overdue ? Math.max(0, 10 - days) : 30,
          chip: overdue ? `Overdue ${days} day${days > 1 ? 's' : ''}` : 'Due today', title: clip(t.title, 140), body: [t.list.displayName, t.body && t.body.content && clip(strip(t.body.content), 120)].filter(Boolean).join(' · '), ref: { list: t.list.id, id: t.id },
          gestures: { right: { label: 'Done', value: 'done', action: 'complete' }, left: { label: 'Not today', value: 'not_today' } } };
      });
    },
    actions: {
      complete: { run: async (c) => { await ms.api(`/me/todo/lists/${c.ref.list}/tasks/${c.ref.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) }, ['Tasks.ReadWrite']); return c.ref; },
        undo: (c, r) => ms.api(`/me/todo/lists/${r.list}/tasks/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'notStarted' }) }, ['Tasks.ReadWrite']) },
      reauth: reauthAction('microsoft'),
    },
  });
})();
