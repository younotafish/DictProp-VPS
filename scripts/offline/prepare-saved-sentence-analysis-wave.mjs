#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [analysisArg, outputArg, maxEntriesArg, ...excludeArgs] = process.argv.slice(2);
if (!analysisArg || !outputArg) {
  throw new Error(
    'Usage: prepare-saved-sentence-analysis-wave.mjs <analysis.json> <output-directory> [max-entries=5000] [published-manifest.json ...]',
  );
}

const readJson = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const analysis = readJson(analysisArg);
const outputDir = resolve(outputArg);
const maxEntries = Number(maxEntriesArg || 5_000);
if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 5_000) {
  throw new Error('max-entries must be an integer from 1 to 5000');
}
if (analysis?.version !== 1 || !Array.isArray(analysis.entries) || analysis.entries.length === 0) {
  throw new Error('Saved sentence analysis manifest is invalid or empty');
}

const publishedIds = new Set();
for (const excludeArg of excludeArgs) {
  const published = readJson(excludeArg);
  if (published?.version !== 1 || !Array.isArray(published.entries)) {
    throw new Error(`Published manifest is invalid: ${excludeArg}`);
  }
  for (const entry of published.entries) {
    if (typeof entry?.id !== 'string' || !entry.id) throw new Error(`Published manifest has an invalid id: ${excludeArg}`);
    publishedIds.add(entry.id);
  }
}

const selected = [];
const sourceIds = new Set();
for (const entry of analysis.entries) {
  if (typeof entry?.id !== 'string' || !entry.id || sourceIds.has(entry.id) ||
      typeof entry.textHash !== 'string' || entry.textHash.length !== 64 ||
      !entry.analysis?.grammar || !Number.isFinite(entry.generatedAt)) {
    throw new Error(`Saved sentence analysis contains an invalid entry: ${String(entry?.id)}`);
  }
  sourceIds.add(entry.id);
  if (publishedIds.has(entry.id)) continue;
  selected.push(entry);
  if (selected.length >= maxEntries) break;
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
  version: 1,
  generatedAt: Date.now(),
  entries: selected,
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  sourceEntries: analysis.entries.length,
  previouslyPublished: publishedIds.size,
  waveEntries: selected.length,
})}\n`);
