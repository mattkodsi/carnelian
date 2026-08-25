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
