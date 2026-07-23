#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [sourceArg, analysisArg, outputArg, maxEntriesArg, ...excludeArgs] = process.argv.slice(2);
if (!sourceArg || !analysisArg || !outputArg) {
  throw new Error(
    'Usage: prepare-example-analysis-wave.mjs <source.json> <analysis.json> <output-directory> [max-entries=2000] [published-manifest.json ...]',
  );
}

const readJson = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const source = readJson(sourceArg);
const analysis = readJson(analysisArg);
const outputDir = resolve(outputArg);
const maxEntries = Number(maxEntriesArg || 2_000);
if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2_000) {
  throw new Error('max-entries must be an integer from 1 to 2000');
}
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
for (const sentence of source.sentences) {
  if (typeof sentence?.id !== 'string' || !sentence.id || sourceIds.has(sentence.id)) {
    throw new Error('Sentence source has an invalid or duplicate id');
  }
  sourceIds.add(sentence.id);
  if (publishedIds.has(sentence.id)) continue;
  const entry = analysisById.get(sentence.id);
  if (!entry || entry.textHash !== sentence.textHash) {
    throw new Error(`Analysis identity mismatch: ${sentence.id}`);
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

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
  version: 1,
  generatedAt: Date.now(),
  entries: selected,
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  sourceEntries: source.sentences.length,
  previouslyPublished: publishedIds.size,
  waveEntries: selected.length,
})}\n`);
