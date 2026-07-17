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

const optionalMedia = /\/(?:neuralTts|transformers\.web|kokoro|ort-wasm)[^/]*\.(?:js|wasm)$/;
const referencedAssets = (source) => {
  const urls = new Set();
  for (const match of source.matchAll(/(?:^|["'(/])(assets\/[A-Za-z0-9_.-]+\.(?:js|css))/g)) {
    const url = `/${match[1]}`;
    if (!optionalMedia.test(url)) urls.add(url);
  }
  for (const match of source.matchAll(/["'(]\.\/([A-Za-z0-9_.-]+\.(?:js|css))/g)) {
    const url = `/assets/${match[1]}`;
    if (!optionalMedia.test(url)) urls.add(url);
  }
  return [...urls];
};

const queue = referencedAssets(html);
const precached = new Set();
while (queue.length > 0 && precached.size < 80) {
  const url = queue.shift();
  if (!url || precached.has(url)) continue;
  const source = readFileSync(resolve(dist, url.slice(1)));
  precached.add(url);
  if (url.endsWith('.js')) {
    for (const dependency of referencedAssets(source.toString('utf8'))) {
      if (!precached.has(dependency)) queue.push(dependency);
    }
  }
}
if (queue.length > 0) throw new Error('Core service-worker asset graph exceeds 80 files');
console.log(`Offline core graph: ${precached.size} hashed assets (optional media excluded)`);
