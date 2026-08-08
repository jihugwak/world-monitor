// World Monitor service worker (PWA / phone build).
//
// Strategy:
//  - App shell (same-origin static assets): stale-while-revalidate, so the
//    installed app opens instantly and updates in the background.
//  - Feed snapshot JSON: network-first with cache fallback, so you get fresh
//    news online and the last snapshot when offline.
//  - Everything cross-origin (YouTube, proxies, article sites): passthrough.
//
// Bump CACHE when the shell strategy changes to evict old caches.
const CACHE = 'wm-shell-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // Precache the entry so a cold offline launch still boots.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html']).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Always try the network first for the live snapshot; fall back to cache
  // offline so the last-known news still renders.
  if (url.pathname.endsWith('/feed-snapshot.json')) {
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(req, { cache: 'no-store' });
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
          return res;
        } catch {
          const cached = await caches.match(req);
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Cross-origin (YouTube embeds, CORS proxies, article links): don't touch.
  if (!sameOrigin) return;

  // App shell: serve from cache, refresh in background.
  e.respondWith(
    (async () => {
      const cached = await caches.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })(),
  );
});
