#!/usr/bin/env node

import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [bundleArg, outputArg, maxEntriesArg, maxBytesArg] = process.argv.slice(2);
if (!bundleArg || !outputArg) {
  throw new Error('Usage: split-image-bundle.mjs <bundle-directory> <output-directory> [max-entries=600] [max-bytes=800000000]');
}
const bundleDir = resolve(bundleArg);
const outputDir = resolve(outputArg);
const maxEntries = Number(maxEntriesArg || 600);
const maxBytes = Number(maxBytesArg || 800_000_000);
if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1_000_000) {
  throw new Error('Chunk limits are invalid');
}

const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
  throw new Error('Image bundle manifest is invalid or empty');
}
mkdirSync(outputDir, { recursive: true });

const chunks = [];
let current = [];
let currentBytes = 0;
for (const entry of manifest.entries) {
  const source = join(bundleDir, entry.imageFile);
  if (!existsSync(source)) throw new Error(`Missing final image ${entry.imageFile}`);
  const bytes = statSync(source).size;
  if (current.length > 0 && (current.length >= maxEntries || currentBytes + bytes > maxBytes)) {
    chunks.push({ entries: current, bytes: currentBytes });
    current = [];
    currentBytes = 0;
  }
  current.push(entry);
  currentBytes += bytes;
}
if (current.length > 0) chunks.push({ entries: current, bytes: currentBytes });

const index = [];
for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
  const name = `chunk-${String(chunkIndex + 1).padStart(4, '0')}`;
  const chunkDir = join(outputDir, name);
  mkdirSync(join(chunkDir, 'images'), { recursive: true });
  for (const entry of chunks[chunkIndex].entries) {
    const source = join(bundleDir, entry.imageFile);
    const destination = join(chunkDir, 'images', basename(entry.imageFile));
    if (!existsSync(destination)) {
      try { linkSync(source, destination); } catch { copyFileSync(source, destination); }
    }
  }
  writeFileSync(join(chunkDir, 'manifest.json'), `${JSON.stringify({
    ...manifest,
    entries: chunks[chunkIndex].entries,
  }, null, 2)}\n`, { mode: 0o600 });
  index.push({ name, entries: chunks[chunkIndex].entries.length, bytes: chunks[chunkIndex].bytes });
}
writeFileSync(join(outputDir, 'chunks.json'), `${JSON.stringify({ chunks: index }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Split ${manifest.entries.length} images into ${chunks.length} chunk(s)\n`);
