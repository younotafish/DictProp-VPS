// Service worker — offline app shell for the installed PWA.
//
// The previous version registered but cached nothing (no fetch handler), so a fully offline launch had
// no shell to load and the app would not open. This caches the shell at runtime and serves it offline:
//   • navigations (index.html): network-first, fall back to the cached shell → always fresh online,
//     still opens offline, and never gets stuck on a stale build.
//   • hashed build assets (/assets/*): cache-first → instant + offline; names are unique per build, so
//     a new deploy just caches its new files (old caches are pruned on activate).
//   • other same-origin GET (icons, manifest): stale-while-revalidate.
//   • /api/* and non-GET: untouched (network only) — the app already falls back to its local IndexedDB
//     cache when the server is unreachable.
//
// NOTE: because the old no-cache SW is already installed on devices, the app must be opened ONCE while
// online after this ships so the new SW installs and warms the cache; offline launches work after that.

const VERSION = 'v2';
const CACHE = `dictprop-${VERSION}`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Warm the navigation shell so the first offline launch after install works.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/').catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('dictprop-') && k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin (e.g. HF model CDN) → straight to network
  if (url.pathname.startsWith('/api/')) return;     // dynamic — never cache; app handles offline locally

  // Navigations → network-first, fall back to the cached shell (same index.html for all SPA routes).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('/', fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match('/')) || (await cache.match(req)) || Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed build assets → cache-first (immutable per build).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })(),
    );
    return;
  }

  // Other same-origin static (icons, manifest) → stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const fetching = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()).catch(() => {}); return res; })
        .catch(() => null);
      return hit || (await fetching) || Response.error();
    })(),
  );
});
