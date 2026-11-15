#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readJson, writePrivateJson } from './offline-io.mjs';

const [outputArg, ...inputArgs] = process.argv.slice(2);
if (!outputArg || inputArgs.length === 0) {
  throw new Error('Usage: merge-sentence-analysis-manifests.mjs <output.json> <analysis.json>...');
}

const entriesById = new Map();
let generatedAt = 0;
for (const inputArg of inputArgs) {
  const manifest = readJson(inputArg);
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`Sentence analysis manifest is invalid: ${inputArg}`);
  }
  generatedAt = Math.max(generatedAt, Number(manifest.generatedAt || 0));
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id ||
        typeof entry.textHash !== 'string' || !entry.textHash || !entry.analysis) {
      throw new Error(`Sentence analysis manifest contains an invalid entry: ${inputArg}`);
    }
    const current = entriesById.get(entry.id);
    if (!current || Number(entry.generatedAt || 0) >= Number(current.generatedAt || 0)) {
      entriesById.set(entry.id, entry);
    }
  }
}

const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writePrivateJson(outputPath, {
  version: 1,
  generatedAt: generatedAt || Date.now(),
  entries: [...entriesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
});
process.stdout.write(`${JSON.stringify({ manifests: inputArgs.length, entries: entriesById.size })}\n`);
