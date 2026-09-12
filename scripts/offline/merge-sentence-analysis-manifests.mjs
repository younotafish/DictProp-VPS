#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [outputArg, ...inputArgs] = process.argv.slice(2);
if (!outputArg || inputArgs.length === 0) {
  throw new Error('Usage: merge-sentence-analysis-manifests.mjs <output.json> <analysis.json>...');
}

const entriesById = new Map();
let generatedAt = 0;
for (const inputArg of inputArgs) {
  const manifest = JSON.parse(readFileSync(resolve(inputArg), 'utf8'));
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
const temporaryPath = `${outputPath}.tmp`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(temporaryPath, `${JSON.stringify({
  version: 1,
  generatedAt: generatedAt || Date.now(),
  entries: [...entriesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
}, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryPath, outputPath);
process.stdout.write(`${JSON.stringify({ manifests: inputArgs.length, entries: entriesById.size })}\n`);
