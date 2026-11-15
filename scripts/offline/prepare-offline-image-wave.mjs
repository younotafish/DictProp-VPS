#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { linkOrCopy, readJson } from './offline-io.mjs';
import { forEachPublishedEntry, parseMaxEntries, printWaveSummary, writeWaveManifest } from './wave-manifests.mjs';

const [sourceArg, outputArg, maxEntriesArg, ...excludeArgs] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error('Usage: prepare-offline-image-wave.mjs <source-directory> <output-directory> [max-entries=100] [published-manifest.json ...]');
}

const sourceDir = resolve(sourceArg);
const outputDir = resolve(outputArg);
const maxEntries = parseMaxEntries(maxEntriesArg, { fallback: 100 });

const manifest = readJson(join(sourceDir, 'manifest.json'));
if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
  throw new Error('Source offline-image manifest is invalid or empty');
}

const publishedIds = new Set();
forEachPublishedEntry(excludeArgs.map(excludeArg => resolve(excludeArg)), { kind: 'image' }, entry => {
  publishedIds.add(entry.imageId);
});

const sourceIds = new Set();
const selected = [];
for (const entry of manifest.entries) {
  if (typeof entry?.imageId !== 'string' || !entry.imageId || sourceIds.has(entry.imageId)) {
    throw new Error(`Source manifest contains an invalid or duplicate image id: ${String(entry?.imageId)}`);
  }
  sourceIds.add(entry.imageId);
  if (publishedIds.has(entry.imageId)) continue;
  if (typeof entry.imageFile !== 'string' || !entry.imageFile.startsWith('images/')) continue;
  // The wave stages images/<basename> under the manifest's own name for it, so a nested path would name a file the
  // wave lacks, and two nested images could share one staged name. The image preparers write only flat names.
  if (entry.imageFile.slice('images/'.length).includes('/')) {
    throw new Error(`Source manifest image is not directly under images/: ${entry.imageFile}`);
  }
  const sourceImage = resolve(sourceDir, entry.imageFile);
  if (!sourceImage.startsWith(`${sourceDir}/`) || !existsSync(sourceImage)) continue;
  selected.push(entry);
  if (selected.length >= maxEntries) break;
}

mkdirSync(join(outputDir, 'images'), { recursive: true });
for (const entry of selected) {
  const sourceImage = resolve(sourceDir, entry.imageFile);
  linkOrCopy(sourceImage, join(outputDir, 'images', basename(entry.imageFile)));
}

writeWaveManifest(outputDir, {
  ...manifest,
  generatedAt: Date.now(),
  entries: selected,
});
printWaveSummary({
  sourceEntries: manifest.entries.length,
  previouslyPublished: publishedIds.size,
  waveEntries: selected.length,
});
