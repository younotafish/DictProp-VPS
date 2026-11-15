#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { linkOrCopy, readJson } from './offline-io.mjs';
import { isDetailedSentenceAnalysis } from './sentence-analysis-contract.mjs';
import { forEachPublishedEntry, parseMaxEntries, printWaveSummary, writeWaveManifest } from './wave-manifests.mjs';

const [sourceArg, analysisArg, imagesArg, outputArg, maxEntriesArg, ...excludeArgs] = process.argv.slice(2);
if (!sourceArg || !analysisArg || !imagesArg || !outputArg) {
  throw new Error('Usage: prepare-example-enrichment-wave.mjs <source.json> <analysis.json> <image-bundle-directory> <output-directory> [max-entries=100] [published-manifest.json ...]');
}

const source = readJson(sourceArg);
const analysis = readJson(analysisArg);
const imageRoot = resolve(imagesArg);
const imageManifest = readJson(join(imageRoot, 'manifest.json'));
const outputDir = resolve(outputArg);
const maxEntries = parseMaxEntries(maxEntriesArg, { fallback: 100, max: 500 });
const requireDetailed = process.env.REQUIRE_DETAILED_SENTENCE_ANALYSIS === '1';
if (source?.version !== 1 || !Array.isArray(source.sentences) ||
    analysis?.version !== 1 || !Array.isArray(analysis.entries) ||
    imageManifest?.version !== 1 || !Array.isArray(imageManifest.entries)) {
  throw new Error('Source, analysis, or image manifest is invalid');
}

const analysisById = uniqueMap(analysis.entries, 'analysis');
const imageById = uniqueMap(imageManifest.entries, 'image');
const sourceById = uniqueMap(source.sentences, 'source');
const publishedIds = new Set();
forEachPublishedEntry(excludeArgs, { since: Number(source.exportedAt || 0) }, (entry, path) => {
  if (typeof entry?.id !== 'string' || !entry.id) throw new Error(`Published manifest has an invalid id: ${path}`);
  const current = sourceById.get(entry.id);
  if (typeof entry.imageFile === 'string' && entry.imageFile &&
      current && entry.textHash === current.textHash) {
    publishedIds.add(entry.id);
  }
});

const selected = [];
for (const sentence of source.sentences) {
  if (sentence.hasImage === true) continue;
  if (publishedIds.has(sentence.id)) continue;
  const analysisEntry = analysisById.get(sentence.id);
  const imageEntry = imageById.get(sentence.id);
  if (!analysisEntry || analysisEntry.textHash !== sentence.textHash) {
    throw new Error(`Analysis identity mismatch: ${sentence.id}`);
  }
  if (requireDetailed && !isDetailedSentenceAnalysis(analysisEntry.analysis)) {
    throw new Error(`Detailed analysis is incomplete: ${sentence.id}`);
  }
  if (!imageEntry || imageEntry.textHash !== sentence.textHash || typeof imageEntry.imageFile !== 'string') {
    throw new Error(`Image identity mismatch: ${sentence.id}`);
  }
  const sourceImage = resolve(imageRoot, imageEntry.imageFile);
  if (!sourceImage.startsWith(`${imageRoot}/`) || !existsSync(sourceImage)) continue;
  selected.push({
    id: sentence.id,
    text: sentence.text,
    lookupHash: sentence.lookupHash,
    textHash: sentence.textHash,
    analysis: analysisEntry.analysis,
    generatedAt: analysisEntry.generatedAt,
    imageFile: `images/${basename(imageEntry.imageFile)}`,
  });
  if (selected.length >= maxEntries) break;
}

mkdirSync(join(outputDir, 'images'), { recursive: true });
for (const entry of selected) {
  const sourceEntry = imageById.get(entry.id);
  const sourceImage = resolve(imageRoot, sourceEntry.imageFile);
  const destination = join(outputDir, entry.imageFile);
  mkdirSync(dirname(destination), { recursive: true });
  linkOrCopy(sourceImage, destination);
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

function uniqueMap(entries, label) {
  const result = new Map();
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || !entry.id || result.has(entry.id)) {
      throw new Error(`${label} manifest has an invalid or duplicate id`);
    }
    result.set(entry.id, entry);
  }
  return result;
}
