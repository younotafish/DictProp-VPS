#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [manifestArg, corpusArg] = process.argv.slice(2);
if (!manifestArg || !corpusArg) {
  throw new Error('Usage: verify-offline-image-manifest.mjs <image-manifest.json> <corpus-manifest.json>');
}

const manifest = JSON.parse(readFileSync(resolve(manifestArg), 'utf8'));
const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
  throw new Error('Offline-image manifest is invalid');
}
const corpusEntries = corpus?.entries || corpus?.items;
if (!Array.isArray(corpusEntries)) throw new Error('Corpus manifest is invalid');

function withoutImages(value) {
  if (Array.isArray(value)) return value.map(withoutImages);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImages(child)]));
}

function sourceHash(data) {
  const stableData = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.fromEntries(Object.entries(data)
      .filter(([key]) => key !== 'analysis' && key !== 'analysisGeneratedAt'))
    : data;
  return createHash('sha256').update(JSON.stringify(withoutImages(stableData))).digest('hex');
}

const parents = new Map(corpusEntries.map(entry => [entry.id, entry]));
const imageIds = new Set();
const failures = [];
for (const [index, entry] of manifest.entries.entries()) {
  if (!entry?.imageId || imageIds.has(entry.imageId)) {
    failures.push(`entry ${index} has an invalid or duplicate image id`);
    continue;
  }
  imageIds.add(entry.imageId);
  const parent = parents.get(entry.parentId);
  if (!parent) failures.push(`entry ${index} parent is absent: ${entry.parentId}`);
  else if (sourceHash(parent.data) !== entry.parentHash) {
    failures.push(`entry ${index} parent content changed: ${entry.parentId}`);
  }
}

const report = {
  imageEntries: manifest.entries.length,
  corpusEntries: corpusEntries.length,
  failures: failures.length,
  failureSample: failures.slice(0, 20),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
