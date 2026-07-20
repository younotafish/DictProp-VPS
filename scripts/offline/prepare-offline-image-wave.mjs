#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [sourceArg, outputArg, maxEntriesArg, ...excludeArgs] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error('Usage: prepare-offline-image-wave.mjs <source-directory> <output-directory> [max-entries=100] [published-manifest.json ...]');
}

const sourceDir = resolve(sourceArg);
const outputDir = resolve(outputArg);
const maxEntries = Number(maxEntriesArg || 100);
if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('max-entries must be a positive integer');

const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'));
if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
  throw new Error('Source offline-image manifest is invalid or empty');
}

const publishedIds = new Set();
for (const excludeArg of excludeArgs) {
  const excludePath = resolve(excludeArg);
  const published = JSON.parse(readFileSync(excludePath, 'utf8'));
  if (published?.version !== 1 || !Array.isArray(published.entries)) {
    throw new Error(`Published image manifest is invalid: ${excludePath}`);
  }
  for (const entry of published.entries) publishedIds.add(entry.imageId);
}

const sourceIds = new Set();
const selected = [];
for (const entry of manifest.entries) {
  if (typeof entry?.imageId !== 'string' || !entry.imageId || sourceIds.has(entry.imageId)) {
    throw new Error(`Source manifest contains an invalid or duplicate image id: ${String(entry?.imageId)}`);
  }
  sourceIds.add(entry.imageId);
  if (publishedIds.has(entry.imageId)) continue;
  if (typeof entry.imageFile !== 'string' || !entry.imageFile.startsWith('images/')) continue;
  const sourceImage = resolve(sourceDir, entry.imageFile);
  if (!sourceImage.startsWith(`${sourceDir}/`) || !existsSync(sourceImage)) continue;
  selected.push(entry);
  if (selected.length >= maxEntries) break;
}

mkdirSync(join(outputDir, 'images'), { recursive: true });
for (const entry of selected) {
  const sourceImage = resolve(sourceDir, entry.imageFile);
  const destination = join(outputDir, 'images', basename(entry.imageFile));
  if (existsSync(destination)) continue;
  try {
    linkSync(sourceImage, destination);
  } catch {
    copyFileSync(sourceImage, destination);
  }
}

writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
  ...manifest,
  generatedAt: Date.now(),
  entries: selected,
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  sourceEntries: manifest.entries.length,
  previouslyPublished: publishedIds.size,
  waveEntries: selected.length,
})}\n`);
