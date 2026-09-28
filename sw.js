// Carnelian service worker — network-first for the app shell.
// The page is a single index.html on GitHub Pages; iOS home-screen apps cache it hard.
// This makes every online load fetch the latest HTML, so updates show on reopen.
// A cached copy is kept only as an offline fallback. API (Supabase) and Cornell
// roster calls are cross-origin and pass straight through — never intercepted.
const CACHE = 'carnelian-shell';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;                 // let API / roster fetches through untouched
  const isShell = req.mode === 'navigate' || req.destination === 'document'
                  || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  if (!isShell) return;                                            // only manage the HTML shell
  e.respondWith(
    fetch(req)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; })
      .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
  );
});

// ---- Web Push: assignment-change notifications ----
// The server sends {title, body, tag, url}. iOS delivers these only to the
// installed (Add to Home Screen) app; a Safari tab gets nothing.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Carnelian';
  const opts = {
    body: d.body || '',
    icon: 'apple-touch-icon.png',
    badge: 'apple-touch-icon.png',
    tag: d.tag || 'carnelian-assignments',
    renotify: true,
    data: { url: d.url || './' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) { if ('focus' in c) { try { await c.focus(); } catch (_) {} return; } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
