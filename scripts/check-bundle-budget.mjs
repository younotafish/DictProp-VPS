import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = resolve('dist');
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const initialScripts = new Set();

for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="\/([^"?]+\.js)"/g)) {
  initialScripts.add(match[1]);
}

if (initialScripts.size === 0) throw new Error('No initial JavaScript assets found in dist/index.html');

let total = 0;
for (const asset of initialScripts) total += gzipSync(readFileSync(resolve(dist, asset))).byteLength;

const limit = 100 * 1024;
const formatted = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
console.log(`Initial JavaScript: ${formatted(total)} gzip across ${initialScripts.size} assets (limit ${formatted(limit)})`);
if (total > limit) process.exitCode = 1;

// The build stamps two file lists into the service worker (vite.config.ts): PRECACHE, installed with every build,
// and OPTIONAL, the voice runtime it caches on first use instead. Reading OPTIONAL from the worker keeps that split
// defined in one place.
const worker = readFileSync(resolve(dist, 'sw.js'), 'utf8');
const stampedList = (name) => {
  const stamped = worker.match(new RegExp(`^const ${name} = (\\[.*\\]);$`, 'm'));
  if (!stamped) throw new Error(`dist/sw.js has no stamped ${name} list`);
  return new Set(JSON.parse(stamped[1]));
};
const workerPrecache = stampedList('PRECACHE');
const optionalMedia = stampedList('OPTIONAL');

const referencedAssets = (source) => {
  const urls = new Set();
  for (const match of source.matchAll(/(?:^|["'(/])(assets\/[A-Za-z0-9_.-]+\.(?:js|css))/g)) {
    const url = `/${match[1]}`;
    if (!optionalMedia.has(url)) urls.add(url);
  }
  for (const match of source.matchAll(/["'(]\.\/([A-Za-z0-9_.-]+\.(?:js|css))/g)) {
    const url = `/assets/${match[1]}`;
    if (!optionalMedia.has(url)) urls.add(url);
  }
  return [...urls];
};

// Rollup writes a chunk's static imports as `from"./x.js"`, or `import"./x.js"` for one kept for its side effects.
// A dynamic import("./x.js") has a parenthesis instead: it loads only when the code that needs it runs.
const staticImports = (source) =>
  [...source.matchAll(/\b(?:from|import)\s*["']\.\/([A-Za-z0-9_.-]+\.js)["']/g)].map((match) => `/assets/${match[1]}`);

// The most files the core graph may hold: a budget, like the initial-JavaScript limit above, on how many files the
// service worker must cache before the app can start offline. A graph that outgrows it fails the check until the limit
// is raised on purpose. The worker itself sets no limit; 80 was its own install limit before it precached whole builds.
const CORE_GRAPH_LIMIT = 80;

// The core graph, from the shell through every file it can load short of the voice runtime, must be precached. Each
// file is queued once, so a file still queued once the limit is reached is one more than the limit.
const queue = referencedAssets(html);
const queued = new Set(queue);
const precached = new Set();
while (queue.length > 0 && precached.size < CORE_GRAPH_LIMIT) {
  const url = queue.shift();
  if (!workerPrecache.has(url)) throw new Error(`dist/sw.js does not precache ${url}`);
  const source = readFileSync(resolve(dist, url.slice(1)));
  precached.add(url);
  if (url.endsWith('.js')) {
    const code = source.toString('utf8');
    for (const dependency of staticImports(code)) {
      if (optionalMedia.has(dependency)) {
        throw new Error(`${url} statically imports ${dependency}, which the service worker caches only on first use, so ${url} could fail to load offline`);
      }
    }
    for (const dependency of referencedAssets(code)) {
      if (queued.has(dependency)) continue;
      queued.add(dependency);
      queue.push(dependency);
    }
  }
}
if (queue.length > 0) throw new Error(`Core service-worker asset graph exceeds ${CORE_GRAPH_LIMIT} files`);

// Every file the worker precaches must exist.
for (const url of workerPrecache) readFileSync(resolve(dist, url.slice(1)));
console.log(`Offline core graph: ${precached.size} hashed assets, all precached by the service worker (optional media excluded)`);
