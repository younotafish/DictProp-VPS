// Service worker — offline app shell for the installed PWA.
//
// Every build stamps its own copy of this worker (see vite.config.ts) with a version and the hashed files the
// build needs, so a deploy changes the worker and browsers install the new one in the background:
//   • install: cache the build's shell and all of its hashed files (the optional voice runtime excluded),
//     reusing files earlier builds already downloaded, then take over at once. A failed download fails the
//     install and the browser tries again on a later visit, so a cached shell always has its code beside it.
//   • navigations (index.html): this build's cached shell, so launches never wait on the network, even a slow
//     or flaky one. A new build opens on the first launch after its worker has installed.
//   • hashed build files (/assets/*): cache-first from any build's cache → a page still running the previous
//     build keeps loading its own code; files not precached (the voice runtime) are cached on first use.
//   • other same-origin GET (icons, manifest): stale-while-revalidate.
//   • /api/* and non-GET: untouched (network only) — the app already falls back to its local IndexedDB
//     cache when the server is unreachable.

// Stamped by the build; the dev server serves these placeholders.
const VERSION = 'dev';
const PRECACHE = [];
const OPTIONAL = [];

const CACHE = `dictprop-${VERSION}`;
// Remembers which build's cache the active worker uses, so an update keeps exactly that one for open pages.
const META = 'dictprop-meta';
const STATIC = ['/manifest.json', '/favicon-32x32.png', '/apple-touch-icon.png', '/pwa-192x192.png'];

/** A usable build file: never an error, and never the HTML shell a server answers for a file it lacks. */
const isAsset = (response) =>
  Boolean(response && response.ok) && !(response.headers.get('content-type') || '').includes('text/html');

/** A usable copy of a hashed build file (whose content never changes) from this build's cache or an earlier one. */
async function cachedAsset(request) {
  const own = await (await caches.open(CACHE)).match(request);
  if (isAsset(own)) return own;
  for (const name of await caches.keys()) {
    if (!name.startsWith('dictprop-') || name === CACHE || name === META) continue;
    const hit = await (await caches.open(name)).match(request);
    if (isAsset(hit)) return hit;
  }
  return undefined;
}

async function precache() {
  const cache = await caches.open(CACHE);
  const shell = await fetch('/', { cache: 'no-cache' });
  if (!shell.ok) throw new Error(`Shell precache failed: ${shell.status}`);
  // A deploy landing mid-install serves a newer shell than these files; the newer worker installs next.
  const html = await shell.clone().text();
  for (const [url] of html.matchAll(/\/assets\/[A-Za-z0-9_.-]+/g)) {
    if (!PRECACHE.includes(url) && !OPTIONAL.includes(url)) throw new Error(`Shell is from another build: ${url}`);
  }

  await Promise.all([
    // A copy an earlier build cached is as good as a download.
    ...PRECACHE.map(async (url) => {
      const response = (await cachedAsset(url)) || (await fetch(url));
      if (!isAsset(response)) throw new Error(`Asset precache failed: ${url} (${response.status})`);
      await cache.put(url, response);
    }),
    ...OPTIONAL.map(async (url) => {
      const earlier = await cachedAsset(url);
      if (earlier) await cache.put(url, earlier);
    }),
    ...STATIC.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Precache failed: ${url} (${response.status})`);
      await cache.put(url, response);
    }),
  ]);
  // Last, so a cached shell always has every file it loads.
  await cache.put('/', shell);
}

async function pruneCaches() {
  const meta = await caches.open(META);
  const previous = await meta.match('/active').then((response) => response && response.text());
  // Nothing recorded means the previous worker predates this scheme: keep its cache this once.
  if (previous) {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('dictprop-') && key !== CACHE && key !== previous && key !== META)
        .map((key) => caches.delete(key)),
    );
  }
  await meta.put('/active', new Response(CACHE));
}

self.addEventListener('install', (event) => {
  // Take over as soon as this build is cached. Pages still running the previous build keep working: its
  // cache stays until the next update, and its files are served from there.
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await pruneCaches();
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

  // Navigations → this build's shell (the same index.html for all SPA routes).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const shell = await (await caches.open(CACHE)).match('/');
        if (shell) return shell;
        try {
          return await fetch(req);
        } catch {
          return (await caches.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed build files → cache-first (immutable per build).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const hit = await cachedAsset(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (isAsset(res)) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
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
