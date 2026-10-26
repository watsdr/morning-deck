/* Morning Deck service worker: cache the app shell, network-first for the API. */
const VERSION = 'md-v19'; // bump on every app release so phones pick up the new shell
const cacheable = (res) => res.ok && res.status === 200 && res.type === 'basic' && !res.headers.get('X-MD-Lock');
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/fonts/jakarta.woff2',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-192.png', '/icons/maskable-512.png', '/icons/favicon-32.png',
  '/assets/noise.webp', '/assets/stamp-yes.svg', '/assets/stamp-no.svg', '/assets/stamp-later.svg', '/assets/stamp-handback.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'no-cache' }).then((r) => cacheable(r) ? c.put(u, r) : null).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin || req.method !== 'GET') return; // POSTs (answers) always go to the network
  if (url.searchParams.has('token')) return; // first-visit sign-in must reach the server to set the cookie
  if (url.pathname === '/signin') return; // sign-in page/endpoint: always network, never cached

  if (url.pathname.startsWith('/api/uploads/')) return;
  if (url.pathname.startsWith('/download/') || url.pathname.startsWith('/.well-known/')) return; // APK + asset links: never cached // photos: straight to the network (private, HTTP-cached by the browser)
  if (url.pathname.startsWith('/api/')) {
    // network-first; fall back to the last good copy when offline
    e.respondWith(fetch(req).then((res) => {
      if (cacheable(res)) { const copy = res.clone(); caches.open(API_CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || new Response(JSON.stringify({ error: 'offline', cards: [], count: 0 }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }

  if (req.mode === 'navigate') {
    // shell: serve cached copy instantly, refresh it in the background (only cache good 200s)
    e.respondWith(caches.match('/', { cacheName: SHELL_CACHE }).then((cached) => {
      const net = fetch(req).then((res) => { if (cacheable(res)) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put('/', copy)); } return res; });
      return cached ? (e.waitUntil(net.catch(() => {})), cached) : net;
    }));
    return;
  }

  // static assets: stale-while-revalidate
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((cached) => {
    const net = fetch(req).then((res) => { if (cacheable(res)) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); } return res; });
    if (cached) { e.waitUntil(net.catch(() => {})); return cached; }
    return net;
  }));
});

// Morning nudge (POST /api/notify on the server). The payload only carries a count.
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Morning Deck', {
    body: d.body || 'Your Morning Deck is ready', tag: d.tag || 'morning-deck-ready', renotify: true,
    icon: '/icons/icon-192.png', badge: '/icons/favicon-64.png', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (new URL(c.url).origin === self.location.origin && 'focus' in c) { c.postMessage({ type: 'md-refresh' }); return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
