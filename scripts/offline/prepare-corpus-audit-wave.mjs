#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [sourceArg, outputArg, maxEntriesArg, ...excludeArgs] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error('Usage: prepare-corpus-audit-wave.mjs <source-manifest.json> <output-directory> [max-entries=500] [published-manifest.json ...]');
}

const source = readJson(sourceArg);
if (source?.version !== 1 || !Array.isArray(source.entries) || source.entries.length === 0) {
  throw new Error('Source corpus audit manifest is invalid or empty');
}
const maxEntries = Number(maxEntriesArg || 500);
if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000) {
  throw new Error('max-entries must be an integer from 1 to 1000');
}

const publishedIds = new Set();
for (const excludeArg of excludeArgs) {
  const published = readJson(excludeArg);
  if (published?.version !== 1 || !Array.isArray(published.entries)) {
    throw new Error(`Published corpus manifest is invalid: ${excludeArg}`);
  }
  for (const entry of published.entries) {
    if (typeof entry?.id !== 'string' || !entry.id) throw new Error(`Published manifest has an invalid id: ${excludeArg}`);
    publishedIds.add(entry.id);
  }
}

const sourceIds = new Set();
for (const entry of source.entries) {
  if (typeof entry?.id !== 'string' || !entry.id || sourceIds.has(entry.id)) {
    throw new Error(`Source manifest has an invalid or duplicate id: ${entry?.id || '<empty>'}`);
  }
  sourceIds.add(entry.id);
}
const usageRank = new Map([
  ['modern_american', 0],
  ['current_general', 1],
  ['narrow_specialized', 3],
  ['british_only', 4],
  ['rare_or_dated', 5],
]);
const prioritized = source.entries.map((entry, sourceIndex) => ({ entry, sourceIndex }))
  .filter(({ entry }) => !publishedIds.has(entry.id))
  .sort((left, right) => {
    const leftRank = left.entry.type === 'sentence' ? 2 : (usageRank.get(left.entry.data?.usageAudit?.status) ?? 6);
    const rightRank = right.entry.type === 'sentence' ? 2 : (usageRank.get(right.entry.data?.usageAudit?.status) ?? 6);
    return leftRank - rightRank || left.sourceIndex - right.sourceIndex;
  });
const selected = prioritized.slice(0, maxEntries).map(({ entry }) => entry);
const outputDir = resolve(outputArg);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
  version: 1,
  generatedAt: source.generatedAt,
  model: source.model,
  entries: selected,
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  sourceEntries: source.entries.length,
  previouslyPublished: publishedIds.size,
  waveEntries: selected.length,
})}\n`);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}
