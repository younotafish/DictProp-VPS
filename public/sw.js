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

const VERSION = 'v3';
const CACHE = `dictprop-${VERSION}`;
const OPTIONAL_MEDIA = /\/(?:neuralTts|transformers\.web|kokoro|ort-wasm)[^/]*\.(?:js|wasm)$/;
const MAX_PRECACHE_ASSETS = 80;

const assetUrls = (text) => {
  const urls = new Set();
  for (const match of text.matchAll(/(?:^|["'(/])(assets\/[A-Za-z0-9_.-]+\.(?:js|css))/g)) {
    const url = `/${match[1]}`;
    if (!OPTIONAL_MEDIA.test(url)) urls.add(url);
  }
  for (const match of text.matchAll(/["'(]\.\/([A-Za-z0-9_.-]+\.(?:js|css))/g)) {
    const url = `/assets/${match[1]}`;
    if (!OPTIONAL_MEDIA.test(url)) urls.add(url);
  }
  return [...urls];
};

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const shell = await fetch('/', { cache: 'no-cache' });
  if (!shell.ok) throw new Error(`Shell precache failed: ${shell.status}`);
  const html = await shell.clone().text();
  await cache.put('/', shell);

  const queued = [
    ...assetUrls(html),
    '/manifest.json',
    '/favicon-32x32.png',
    '/apple-touch-icon.png',
    '/pwa-192x192.png',
  ];
  const seen = new Set();
  while (queued.length > 0 && seen.size < MAX_PRECACHE_ASSETS) {
    const url = queued.shift();
    if (!url || seen.has(url) || OPTIONAL_MEDIA.test(url)) continue;
    seen.add(url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Asset precache failed: ${url} (${response.status})`);
    if (url.endsWith('.js')) {
      const source = await response.clone().text();
      for (const dependency of assetUrls(source)) {
        if (!seen.has(dependency)) queued.push(dependency);
      }
    }
    await cache.put(url, response);
  }
  if (queued.length > 0) throw new Error('Core asset graph exceeded the precache limit');
}

self.addEventListener('install', (event) => {
  // Do not replace a worker underneath a running build. The update activates after existing
  // clients close, when its matching hashed asset graph is ready.
  event.waitUntil(precacheShell());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
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
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(req);
          // Only ever cache a genuine shell. During a redeploy the server can answer with a 502/500;
          // caching that as '/' would poison every future offline launch, so keep the last good shell
          // and serve it instead of the error page whenever we have one.
          if (fresh.ok) {
            cache.put('/', fresh.clone()).catch(() => {});
            return fresh;
          }
          return (await cache.match('/')) || fresh;
        } catch {
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
