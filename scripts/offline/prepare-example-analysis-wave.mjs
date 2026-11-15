#!/usr/bin/env node

import { resolve } from 'node:path';
import { readJson } from './offline-io.mjs';
import { isDetailedSentenceAnalysis } from './sentence-analysis-contract.mjs';
import { forEachPublishedEntry, parseMaxEntries, printWaveSummary, writeWaveManifest } from './wave-manifests.mjs';

const [sourceArg, analysisArg, outputArg, maxEntriesArg, ...excludeArgs] = process.argv.slice(2);
if (!sourceArg || !analysisArg || !outputArg) {
  throw new Error(
    'Usage: prepare-example-analysis-wave.mjs <source.json> <analysis.json> <output-directory> [max-entries=2000] [published-manifest.json ...]',
  );
}

const source = readJson(sourceArg);
const analysis = readJson(analysisArg);
const outputDir = resolve(outputArg);
const maxEntries = parseMaxEntries(maxEntriesArg, { fallback: 2_000, max: 2_000 });
const requireDetailed = process.env.REQUIRE_DETAILED_SENTENCE_ANALYSIS === '1';
if (source?.version !== 1 || !Array.isArray(source.sentences) ||
    analysis?.version !== 1 || !Array.isArray(analysis.entries)) {
  throw new Error('Source or analysis manifest is invalid');
}

const analysisById = new Map();
for (const entry of analysis.entries) {
  if (typeof entry?.id !== 'string' || !entry.id || analysisById.has(entry.id)) {
    throw new Error('Analysis manifest has an invalid or duplicate id');
  }
  analysisById.set(entry.id, entry);
}
const publishedIds = new Set();
forEachPublishedEntry(excludeArgs, { since: Number(source.exportedAt || 0) }, (entry, path) => {
  if (typeof entry?.id !== 'string' || !entry.id) throw new Error(`Published manifest has an invalid id: ${path}`);
  publishedIds.add(entry.id);
});

const selected = [];
const sourceIds = new Set();
for (const sentence of source.sentences) {
  if (typeof sentence?.id !== 'string' || !sentence.id || sourceIds.has(sentence.id)) {
    throw new Error('Sentence source has an invalid or duplicate id');
  }
  sourceIds.add(sentence.id);
  if (sentence.hasAnalysis === true) continue;
  if (publishedIds.has(sentence.id)) continue;
  const entry = analysisById.get(sentence.id);
  if (!entry || entry.textHash !== sentence.textHash) {
    throw new Error(`Analysis identity mismatch: ${sentence.id}`);
  }
  if (requireDetailed && !isDetailedSentenceAnalysis(entry.analysis)) {
    throw new Error(`Detailed analysis is incomplete: ${sentence.id}`);
  }
  selected.push({
    id: sentence.id,
    text: sentence.text,
    lookupHash: sentence.lookupHash,
    textHash: sentence.textHash,
    analysis: entry.analysis,
    generatedAt: entry.generatedAt,
  });
  if (selected.length >= maxEntries) break;
}

writeWaveManifest(outputDir, {
  version: 1,
  generatedAt: Date.now(),
  entries: selected,
});
printWaveSummary({
  sourceEntries: source.sentences.length,
  previouslyPublished: publishedIds.size,
  waveEntries: selected.length,
});
