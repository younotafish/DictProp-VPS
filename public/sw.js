// Service worker — offline app shell for the installed PWA.
//
// Every build stamps its own copy of this worker (see vite.config.ts) with a version and the hashed files the
// build needs, so a deploy changes the worker and browsers install the new one in the background:
//   • install: cache the build's shell and all of its hashed files (the optional voice runtime excluded),
//     reusing files earlier builds already downloaded, then take over at once. A failed download fails the
//     install and the browser tries again on a later visit, so a cached shell always has its code beside it.
//   • navigations to the app (/ or /index.html): this build's cached shell, so launches never wait on the
//     network, even a slow or flaky one. A new build opens on the first launch after its worker has installed.
//     Other paths on this origin are separate sites behind their own auth (the trip pages) → network only.
//   • hashed build files (/assets/*): cache-first from any build's cache → a page still running the previous
//     build keeps loading its own code. The voice runtime isn't precached: it's cached on first use, in one
//     cache all builds share, since its files seldom change and a copy per build would cost tens of megabytes.
//   • the app's own root files (icons, manifest): stale-while-revalidate. Nothing else is stored, so a
//     response another site on this origin marks private never lands in Cache Storage.
//   • /api/* and non-GET: untouched (network only) — the app already falls back to its local IndexedDB
//     cache when the server is unreachable.

// Stamped by the build; the dev server serves these placeholders.
const VERSION = 'dev';
const PRECACHE = [];
const OPTIONAL = [];

const CACHE = `dictprop-${VERSION}`;
// The voice runtime (OPTIONAL), shared by builds; an update keeps the files of this build and the previous one.
const MEDIA = 'dictprop-media';
// Remembers which build's cache the active worker uses, so an update keeps exactly that one for open pages.
const META = 'dictprop-meta';
const STATIC = ['/manifest.json', '/favicon-32x32.png', '/apple-touch-icon.png', '/pwa-192x192.png'];
const ROOT_FILES = new Set([...STATIC, '/pwa-512x512.png', '/pwa-maskable-512x512.png', '/icon.svg']);
const isAppNavigation = (url) => url.pathname === '/' || url.pathname === '/index.html';

/** A usable build file: never an error, and never the HTML shell a server answers for a file it lacks. */
const isAsset = (response) =>
  Boolean(response && response.ok) && !(response.headers.get('content-type') || '').includes('text/html');

/** A usable copy of a hashed build file (whose content never changes) from this build's cache or an earlier one. */
async function cachedAsset(request) {
  for (const name of [CACHE, MEDIA]) {
    const hit = await (await caches.open(name)).match(request);
    if (isAsset(hit)) return hit;
  }
  for (const name of await caches.keys()) {
    if (!name.startsWith('dictprop-') || name === CACHE || name === MEDIA || name === META) continue;
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
    // Voice-runtime files that a build from before the shared cache kept in its own cache move there once.
    ...OPTIONAL.map(async (url) => {
      const media = await caches.open(MEDIA);
      if (isAsset(await media.match(url))) return;
      const earlier = await cachedAsset(url);
      if (earlier) await media.put(url, earlier);
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
        .filter((key) => key.startsWith('dictprop-') && key !== CACHE && key !== previous && key !== MEDIA && key !== META)
        .map((key) => caches.delete(key)),
    );
  }
  const previousOptional = await meta.match('/optional').then((response) => (response ? response.json() : [])).catch(() => []);
  const keep = new Set([...OPTIONAL, ...previousOptional]);
  const media = await caches.open(MEDIA);
  await Promise.all(
    (await media.keys()).filter((request) => !keep.has(new URL(request.url).pathname)).map((request) => media.delete(request)),
  );
  await meta.put('/active', new Response(CACHE));
  await meta.put('/optional', new Response(JSON.stringify(OPTIONAL)));
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

  // Navigations to the app → this build's shell. Any other page on this origin is not ours to answer.
  if (req.mode === 'navigate') {
    if (!isAppNavigation(url)) return;
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
          const cache = await caches.open(OPTIONAL.includes(url.pathname) ? MEDIA : CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      })(),
    );
    return;
  }

  // The app's root files (icons, manifest) → stale-while-revalidate.
  if (!ROOT_FILES.has(url.pathname)) return;
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
