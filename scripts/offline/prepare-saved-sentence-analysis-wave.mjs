#!/usr/bin/env node

import { resolve } from 'node:path';
import { readJson } from './offline-io.mjs';
import { isDetailedSentenceAnalysis } from './sentence-analysis-contract.mjs';
import { forEachPublishedEntry, parseMaxEntries, printWaveSummary, writeWaveManifest } from './wave-manifests.mjs';

const [analysisArg, outputArg, maxEntriesArg, ...excludeArgs] = process.argv.slice(2);
if (!analysisArg || !outputArg) {
  throw new Error(
    'Usage: prepare-saved-sentence-analysis-wave.mjs <analysis.json> <output-directory> [max-entries=5000] [published-manifest.json ...]',
  );
}

const analysis = readJson(analysisArg);
const outputDir = resolve(outputArg);
const maxEntries = parseMaxEntries(maxEntriesArg, { fallback: 5_000, max: 5_000 });
const requireDetailed = process.env.REQUIRE_DETAILED_SENTENCE_ANALYSIS === '1';
if (analysis?.version !== 1 || !Array.isArray(analysis.entries) || analysis.entries.length === 0) {
  throw new Error('Saved sentence analysis manifest is invalid or empty');
}

const entryIdentity = entry => `${entry.id}\0${entry.textHash}`;
const publishedEntries = new Set();
// Each cycle rebuilds the analysis manifest from sentences production still lacks, so an older publication
// did not survive there (a device can re-save a sentence without its analysis) and is published again.
forEachPublishedEntry(excludeArgs, { since: Number(analysis.generatedAt || 0) }, (entry, path) => {
  if (typeof entry?.id !== 'string' || !entry.id ||
      typeof entry.textHash !== 'string' || entry.textHash.length !== 64) {
    throw new Error(`Published manifest has an invalid identity: ${path}`);
  }
  publishedEntries.add(entryIdentity(entry));
});

const selected = [];
const sourceIds = new Set();
for (const entry of analysis.entries) {
  if (typeof entry?.id !== 'string' || !entry.id || sourceIds.has(entry.id) ||
      typeof entry.textHash !== 'string' || entry.textHash.length !== 64 ||
      !entry.analysis?.grammar || !Number.isFinite(entry.generatedAt) ||
      (requireDetailed && !isDetailedSentenceAnalysis(entry.analysis))) {
    throw new Error(`Saved sentence analysis contains an invalid entry: ${String(entry?.id)}`);
  }
  sourceIds.add(entry.id);
  if (publishedEntries.has(entryIdentity(entry))) continue;
  selected.push(entry);
  if (selected.length >= maxEntries) break;
}

writeWaveManifest(outputDir, {
  version: 1,
  generatedAt: Date.now(),
  entries: selected,
});
printWaveSummary({
  sourceEntries: analysis.entries.length,
  previouslyPublished: publishedEntries.size,
  waveEntries: selected.length,
});
