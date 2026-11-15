import assert from 'node:assert/strict';
import test from 'node:test';
import { stampServiceWorker } from '../../vite.config.ts';
import { readRepoFile } from '../support/paths.ts';
import { FakeNetwork, MemoryCacheStorage, runServiceWorker, type ServiceWorkerHarness } from '../support/service-worker.ts';

// public/sw.js, stamped the way the build stamps it, run against in-memory caches and a scripted server: installing
// builds one after another, activating each over the last, and answering the app's requests online and offline.

const SOURCE = readRepoFile('public/sw.js');
const STATIC = ['/manifest.json', '/favicon-32x32.png', '/apple-touch-icon.png', '/pwa-192x192.png'];
const ROOT_FILES = [...STATIC, '/pwa-512x512.png', '/pwa-maskable-512x512.png'];

const stampedList = (worker: string, name: string): string[] =>
  JSON.parse(worker.match(new RegExp(`^const ${name} = (\\[.*\\]);$`, 'm'))?.[1] ?? 'null');

interface Build {
  html: string;
  /** Its hashed files, as Vite names them. */
  files: string[];
  worker: string;
  /** The cache the worker keeps this build in. */
  cache: string;
}

/** A build whose shell loads index-<id>.js, the vendor chunk and index-<id>.css, plus its other hashed files. */
function build(id: string, files: string[]): Build {
  const html = '<!doctype html>' +
    `<script type="module" crossorigin src="/assets/index-${id}.js"></script>` +
    '<link rel="modulepreload" crossorigin href="/assets/react-vendor-r0.js">' +
    `<link rel="stylesheet" crossorigin href="/assets/index-${id}.css">`;
  const all = [`assets/index-${id}.js`, 'assets/react-vendor-r0.js', `assets/index-${id}.css`, ...files];
  const worker = stampServiceWorker(SOURCE, { html, files: ['index.html', ...all] });
  const version = worker.match(/^const VERSION = '([0-9a-f]{16})';$/m)?.[1];
  assert.ok(version, 'the worker is stamped with a version');
  return { html, files: all, worker, cache: `dictprop-${version}` };
}

const ONE = build('a1', ['assets/DetailView-d1.js', 'assets/neuralTts-n1.js', 'assets/kokoroWorker-k1.js', 'assets/ort-wasm-simd-threaded.jsep-w1.wasm']);
const TWO = build('a2', ['assets/DetailView-d2.js', 'assets/neuralTts-n2.js', 'assets/kokoroWorker-k1.js', 'assets/ort-wasm-simd-threaded.jsep-w1.wasm']);
const THREE = build('a3', ['assets/DetailView-d3.js', 'assets/neuralTts-n3.js', 'assets/kokoroWorker-k3.js', 'assets/ort-wasm-simd-threaded.jsep-w1.wasm']);

/** What the server sends for a file of a build. */
const contents = (path: string): string => `/* ${path} */`;

/** Puts a build on the server in place of the last one, as a deploy does. */
function deploy(network: FakeNetwork, { html, files }: Build): void {
  network.clear();
  network.serve('/', html);
  network.serve('/index.html', html);
  for (const file of files) network.serve(`/${file}`, contents(`/${file}`));
  for (const path of ROOT_FILES) network.serve(path, contents(path));
}

/** A device that installed and activated each build in turn, the last one current. */
async function device(builds: Build[], caches = new MemoryCacheStorage()) {
  const network = new FakeNetwork();
  let sw: ServiceWorkerHarness | undefined;
  for (const next of builds) {
    deploy(network, next);
    sw = runServiceWorker(next.worker, { caches, network });
    await sw.install();
    await sw.activate();
  }
  assert.ok(sw, 'at least one build');
  return { sw, caches, network };
}

const asset = (path: string) => new Response(contents(path), { headers: { 'content-type': 'text/javascript' } });

test('the build precaches every hashed file except the voice runtime, which is cached on first use', () => {
  assert.deepEqual(stampedList(ONE.worker, 'PRECACHE'), [
    '/assets/DetailView-d1.js', '/assets/index-a1.css', '/assets/index-a1.js', '/assets/react-vendor-r0.js',
  ]);
  assert.deepEqual(stampedList(ONE.worker, 'OPTIONAL'), [
    '/assets/kokoroWorker-k1.js', '/assets/neuralTts-n1.js', '/assets/ort-wasm-simd-threaded.jsep-w1.wasm',
  ]);
  const library = stampServiceWorker(SOURCE, { html: '', files: ['assets/transformers.web-t1.js'] });
  assert.deepEqual(stampedList(library, 'OPTIONAL'), ['/assets/transformers.web-t1.js']);
});

test('the worker\'s version follows the shell and the hashed files, in any order, and nothing else', () => {
  const version = (html: string, files: string[]) =>
    stampServiceWorker(SOURCE, { html, files }).match(/^const VERSION = '(.*)';$/m)?.[1];
  const base = version('<html>', ['assets/a-1.js', 'assets/b-2.js']);
  assert.match(base ?? '', /^[0-9a-f]{16}$/);
  assert.equal(version('<html>', ['assets/b-2.js', 'index.html', 'assets/a-1.js']), base);
  assert.notEqual(version('<html> ', ['assets/a-1.js', 'assets/b-2.js']), base);
  assert.notEqual(version('<html>', ['assets/a-1.js', 'assets/b-3.js']), base);
});

test('stamping fails loudly when sw.js loses one of the placeholders the build fills in', () => {
  for (const placeholder of ["const VERSION = 'dev';", 'const PRECACHE = [];', 'const OPTIONAL = [];']) {
    assert.ok(SOURCE.includes(placeholder), placeholder);
    assert.throws(
      () => stampServiceWorker(SOURCE.replace(placeholder, '// gone'), { html: '', files: [] }),
      { message: `sw.js no longer contains \`${placeholder}\`` },
    );
  }
});

test('installing a build caches its shell, hashed files and icons, the shell last, then takes over at once', async () => {
  const network = new FakeNetwork();
  deploy(network, ONE);
  const sw = runServiceWorker(ONE.worker, { network });
  await sw.install();

  const cache = await sw.caches.open(ONE.cache);
  assert.deepEqual(cache.paths(), [
    '/', '/apple-touch-icon.png', '/assets/DetailView-d1.js', '/assets/index-a1.css', '/assets/index-a1.js',
    '/assets/react-vendor-r0.js', '/favicon-32x32.png', '/manifest.json', '/pwa-192x192.png',
  ]);
  assert.equal(cache.stored.at(-1), '/', 'a cached shell always has every file it loads');
  assert.equal(await cache.text('/'), ONE.html);
  assert.deepEqual(network.requests.find(request => request.path === '/')?.init, { cache: 'no-cache' });
  for (const path of stampedList(ONE.worker, 'OPTIONAL')) assert.ok(!network.paths().includes(path), `${path} waits for first use`);
  assert.equal(sw.calls.skipWaiting, 1);
});

test('installing the next build reuses the files earlier builds cached and downloads only what changed', async () => {
  const { caches, network } = await device([ONE]);
  deploy(network, TWO);
  const fetchedBefore = network.requests.length;
  const next = runServiceWorker(TWO.worker, { caches, network });
  await next.install();

  const downloaded = network.paths().slice(fetchedBefore).filter(path => path.startsWith('/assets/')).sort();
  assert.deepEqual(downloaded, ['/assets/DetailView-d2.js', '/assets/index-a2.css', '/assets/index-a2.js']);
  assert.equal(await (await caches.open(TWO.cache)).text('/assets/react-vendor-r0.js'), contents('/assets/react-vendor-r0.js'));
});

test('voice-runtime files a build from before the shared voice cache kept in its own cache move there at install', async () => {
  const caches = new MemoryCacheStorage();
  await (await caches.open('dictprop-legacy')).put('/assets/kokoroWorker-k1.js', asset('/assets/kokoroWorker-k1.js'));
  const network = new FakeNetwork();
  deploy(network, ONE);
  await runServiceWorker(ONE.worker, { caches, network }).install();

  const media = await caches.open('dictprop-media');
  assert.deepEqual(media.paths(), ['/assets/kokoroWorker-k1.js']);
  assert.equal(await media.text('/assets/kokoroWorker-k1.js'), contents('/assets/kokoroWorker-k1.js'));
  assert.ok(!network.paths().some(path => path.includes('kokoroWorker') || path.includes('ort-wasm')));
});

test('an install fails, leaving no shell for the browser to open, when the server already has a newer build', async () => {
  const network = new FakeNetwork();
  deploy(network, TWO);
  const sw = runServiceWorker(ONE.worker, { network });
  await assert.rejects(sw.install(), { message: 'Shell is from another build: /assets/index-a2.js' });
  assert.equal(await (await sw.caches.open(ONE.cache)).match('/'), undefined);
  assert.equal(sw.calls.skipWaiting, 0);
});

test('an install fails when a file or icon fails to download or comes back as a page, or when offline', async () => {
  const failures: [string, (network: FakeNetwork) => void, string | RegExp][] = [
    ['missing file', network => network.serve('/assets/DetailView-d1.js', 'gone', { status: 404 }),
      'Asset precache failed: /assets/DetailView-d1.js (404)'],
    ['page for a file', network => network.serve('/assets/DetailView-d1.js', '<!doctype html>', { headers: { 'content-type': 'text/html' } }),
      'Asset precache failed: /assets/DetailView-d1.js (200)'],
    ['missing icon', network => network.serve('/manifest.json', 'gone', { status: 404 }), 'Precache failed: /manifest.json (404)'],
    ['offline', network => { network.online = false; }, /Failed to fetch/],
  ];
  for (const [name, breakIt, error] of failures) {
    const network = new FakeNetwork();
    deploy(network, ONE);
    breakIt(network);
    const sw = runServiceWorker(ONE.worker, { network });
    await assert.rejects(sw.install(), typeof error === 'string' ? { message: error } : error, name);
    assert.equal(await (await sw.caches.open(ONE.cache)).match('/'), undefined, name);
    assert.equal(sw.calls.skipWaiting, 0, name);
  }
});

test('activating a build keeps the previous build\'s cache for pages still running it and deletes older ones', async () => {
  const caches = new MemoryCacheStorage();
  await caches.open('another-app');
  const { network } = await device([ONE, TWO], caches);
  deploy(network, THREE);
  const three = runServiceWorker(THREE.worker, { caches, network });
  await three.install();
  assert.deepEqual(caches.names(), ['another-app', ONE.cache, TWO.cache, THREE.cache, 'dictprop-media', 'dictprop-meta'].sort());

  await three.activate();
  assert.deepEqual(caches.names(), ['another-app', TWO.cache, THREE.cache, 'dictprop-media', 'dictprop-meta'].sort());
  const meta = await caches.open('dictprop-meta');
  assert.equal(await meta.text('/active'), THREE.cache);
  assert.deepEqual(JSON.parse(await meta.text('/optional') ?? 'null'), stampedList(THREE.worker, 'OPTIONAL'));
  assert.equal(three.calls.claim, 1);
});

test('the first activation after a worker that kept no record keeps every cache this once', async () => {
  const caches = new MemoryCacheStorage();
  await (await caches.open('dictprop-legacy')).put('/', new Response('legacy shell'));
  const { network } = await device([ONE], caches);
  assert.ok(caches.names().includes('dictprop-legacy'));

  deploy(network, TWO);
  const two = runServiceWorker(TWO.worker, { caches, network });
  await two.install();
  await two.activate();
  assert.deepEqual(caches.names(), [ONE.cache, TWO.cache, 'dictprop-media', 'dictprop-meta'].sort());
});

test('the shared voice cache keeps this build\'s and the previous build\'s voice files and drops the rest', async () => {
  for (const [record, kept] of [
    [JSON.stringify(['/assets/kokoroWorker-k1.js']), ['/assets/kokoroWorker-k1.js', '/assets/kokoroWorker-k3.js']],
    ['not json', ['/assets/kokoroWorker-k3.js']],
  ] as const) {
    const caches = new MemoryCacheStorage();
    const media = await caches.open('dictprop-media');
    for (const path of ['/assets/kokoroWorker-k0.js', '/assets/kokoroWorker-k1.js', '/assets/kokoroWorker-k3.js']) await media.put(path, asset(path));
    await (await caches.open('dictprop-meta')).put('/optional', new Response(record));
    await device([THREE], caches);
    assert.deepEqual(media.paths(), kept, record);
  }
});

test('launches open from this build\'s cached shell without the network, online or offline', async () => {
  const { sw, network } = await device([ONE]);
  const fetchedBefore = network.requests.length;
  for (const online of [true, false]) {
    network.online = online;
    for (const path of ['/', '/index.html']) {
      const launch = sw.fetch(path, { mode: 'navigate' });
      assert.equal(await (await launch.response)?.text(), ONE.html, `${path} ${online ? 'online' : 'offline'}`);
    }
  }
  assert.equal(network.requests.length, fetchedBefore);
});

test('before its shell is cached, a launch goes to the network, and offline to any build\'s shell or an error', async () => {
  const caches = new MemoryCacheStorage();
  const network = new FakeNetwork();
  deploy(network, ONE);
  const sw = runServiceWorker(ONE.worker, { caches, network });
  assert.equal(await (await sw.fetch('/', { mode: 'navigate' }).response)?.text(), ONE.html);

  network.online = false;
  await (await caches.open('dictprop-older')).put('/', new Response('older shell'));
  assert.equal(await (await sw.fetch('/', { mode: 'navigate' }).response)?.text(), 'older shell');
  await caches.delete('dictprop-older');
  assert.equal((await sw.fetch('/', { mode: 'navigate' }).response)?.type, 'error');
});

test('the other sites on this origin, the API, other methods and other origins go to the network untouched', async () => {
  const { sw } = await device([ONE]);
  const untouched: [string, { mode?: string; method?: string }][] = [
    ['/nz-japan-2026/', { mode: 'navigate' }],
    ['/nz-japan-2026/itinerary.html', { mode: 'navigate' }],
    ['/nz-japan-2026/photo.jpg', {}],
    ['/sd-cards/', { mode: 'navigate' }],
    ['/study', { mode: 'navigate' }],
    ['/api/items', { mode: 'cors' }],
    ['/api/items', { mode: 'cors', method: 'PUT' }],
    ['/assets/index-a1.js', { method: 'POST' }],
    ['/robots.txt', {}],
    ['https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/onnx/model.onnx', { mode: 'cors' }],
  ];
  for (const [path, request] of untouched) assert.equal(sw.fetch(path, request).response, undefined, `${request.method ?? 'GET'} ${path}`);
});

test('hashed files come from any build\'s cache, so a page still running the previous build keeps loading its code', async () => {
  const { sw, network } = await device([ONE, TWO]);
  network.online = false;
  for (const path of ['/assets/DetailView-d1.js', '/assets/DetailView-d2.js', '/assets/react-vendor-r0.js']) {
    assert.equal(await (await sw.fetch(path).response)?.text(), contents(path), path);
  }
});

test('a hashed file in no cache comes from the network; offline it fails, and a page sent in its place passes through', async () => {
  const { sw, network, caches } = await device([ONE]);
  assert.equal(await (await sw.fetch('/assets/kokoroWorker-k1.js').response)?.text(), contents('/assets/kokoroWorker-k1.js'));

  network.serve('/assets/Gone-x9.js', '<!doctype html>', { headers: { 'content-type': 'text/html' } });
  const page = sw.fetch('/assets/Gone-x9.js');
  assert.equal((await page.response)?.headers.get('content-type'), 'text/html');
  await page.settled();
  assert.equal(page.extensions.length, 0);
  assert.equal(await caches.match('/assets/Gone-x9.js'), undefined, 'no cache stores a page under a file\'s name');

  network.online = false;
  await assert.rejects(sw.fetch('/assets/ort-wasm-simd-threaded.jsep-w1.wasm').response ?? Promise.resolve(), /Failed to fetch/);
});

test('a hashed file fetched on a miss is kept, the voice runtime in the shared cache, and the worker lives until it is', async () => {
  const { sw, caches } = await device([ONE]);
  await (await caches.open(ONE.cache)).delete('/assets/DetailView-d1.js');
  for (const [path, cache] of [['/assets/kokoroWorker-k1.js', 'dictprop-media'], ['/assets/DetailView-d1.js', ONE.cache]]) {
    const request = sw.fetch(path);
    assert.equal(await (await request.response)?.text(), contents(path), path);
    assert.equal(request.extensions.length, 1, `${path}: the write extends the event, past the response`);
    await request.settled();
    assert.equal(await (await caches.open(cache)).text(path), contents(path), path);
  }
});

test('a cached icon or manifest answers at once, and the worker lives until the fresh copy is stored', async () => {
  const { sw, network, caches } = await device([ONE]);
  network.serve('/manifest.json', 'newer manifest');
  const request = sw.fetch('/manifest.json');
  assert.equal(await (await request.response)?.text(), contents('/manifest.json'));
  assert.equal(request.extensions.length, 1);
  await request.settled();
  assert.equal(await (await caches.open(ONE.cache)).text('/manifest.json'), 'newer manifest');

  network.online = false;
  const offline = sw.fetch('/manifest.json');
  assert.equal(await (await offline.response)?.text(), 'newer manifest');
  await offline.settled();
  assert.equal(await (await caches.open(ONE.cache)).text('/manifest.json'), 'newer manifest');
});

test('icons and the manifest answer from the cache, else the network, else an error', async () => {
  const { sw, network } = await device([ONE]);
  network.serve('/manifest.json', 'newer manifest');
  assert.equal(await (await sw.fetch('/manifest.json').response)?.text(), contents('/manifest.json'));
  assert.equal(await (await sw.fetch('/pwa-512x512.png').response)?.text(), contents('/pwa-512x512.png'));

  network.online = false;
  assert.equal(await (await sw.fetch('/pwa-192x192.png').response)?.text(), contents('/pwa-192x192.png'));
  assert.equal((await sw.fetch('/pwa-maskable-512x512.png').response)?.type, 'error');
});
