/* Morning Deck service worker: cache the app shell, network-first for the API.
   Never store a 401 or the sign-in lock page — a stale session must not become the offline shell. */
const VERSION = 'md-v10'; // bump on every app release so phones pick up the new shell
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/fonts/jakarta.woff2',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-192.png', '/icons/maskable-512.png', '/icons/favicon-32.png'];

function cacheable(res) {
  if (!res || res.type !== 'basic' || !res.ok || res.status === 401) return false;
  if (res.headers.get('X-MD-Lock') === '1') return false;
  if (/\bno-store\b/i.test(res.headers.get('Cache-Control') || '')) return false;
  return true;
}
// Drop a response the page will not read. Leaving the body open pins an HTTP/1 connection and the install fetch stalls.
function discard(res) {
  try { if (res && res.body) res.body.cancel(); } catch (_) {}
}
function notifyLocked() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) c.postMessage({ type: 'md-unauthorized' });
  });
}

self.addEventListener('install', (e) => {
  // Don't let a signed-out precache (401 or the lock page) fail the install or stick as the shell.
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map(async (path) => {
      try {
        const res = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin' }));
        if (cacheable(res)) await c.put(path, res);
        else discard(res);
      } catch (_) { /* offline or rejected: skip this file, still take the new worker */ }
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin || req.method !== 'GET') return; // POSTs (answers, sign-in) always go to the network
  if (url.searchParams.has('token')) return; // sign-in links must reach the server; never cache them

  if (url.pathname.startsWith('/api/uploads/')) return; // photos: straight to the network (private, HTTP-cached by the browser)
  if (url.pathname.startsWith('/api/')) {
    // network-first; fall back to the last good copy only when the network itself fails. A 401 is not cached and not retried.
    e.respondWith(fetch(req).then((res) => {
      if (res.status === 401) { e.waitUntil(notifyLocked()); return res; }
      if (cacheable(res)) { const copy = res.clone(); caches.open(API_CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || new Response(JSON.stringify({ error: 'offline', cards: [], count: 0 }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }

  if (req.mode === 'navigate') {
    // shell: serve the cached app instantly, refresh it in the background. Never replace it with a 401 or the lock page.
    e.respondWith(caches.match('/', { cacheName: SHELL_CACHE }).then((cached) => {
      const net = fetch(req).then((res) => storeShell(res, cached ? null : res, '/'));
      return cached ? (e.waitUntil(net.catch(() => {})), cached) : net;
    }));
    return;
  }

  // static assets: stale-while-revalidate, good responses only
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((cached) => {
    const net = fetch(req).then((res) => storeShell(res, cached ? null : res, req));
    if (cached) { e.waitUntil(net.catch(() => {})); return cached; }
    return net;
  }));
});

// `pass` is the response the page will read (null when a cached copy is already being served).
function storeShell(res, pass, key) {
  if (cacheable(res)) {
    const copy = pass ? res.clone() : res;
    caches.open(SHELL_CACHE).then((c) => c.put(key, copy)).catch(() => discard(copy));
    return pass || res;
  }
  if (!pass) discard(res);
  return res;
}
