#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [outputArg, ...inputArgs] = process.argv.slice(2);
if (!outputArg || inputArgs.length === 0) {
  throw new Error('Usage: merge-sentence-usage-adjudications.mjs <output.json> <base.json> [supplemental.json ...]');
}

const entriesByKey = new Map();
const models = new Set();
let generatedAt = 0;
for (const inputArg of inputArgs) {
  const manifest = JSON.parse(readFileSync(resolve(inputArg), 'utf8'));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`Usage adjudication manifest is invalid: ${inputArg}`);
  }
  const inputKeys = new Set();
  for (const entry of manifest.entries) {
    const key = groupKey(entry);
    if (!key || inputKeys.has(key) || !entry.decision || !Array.isArray(entry.examples)) {
      throw new Error(`Usage adjudication contains an invalid or duplicate group: ${key || '<empty>'}`);
    }
    inputKeys.add(key);
    entriesByKey.set(key, entry);
  }
  if (typeof manifest.model === 'string' && manifest.model.trim()) models.add(manifest.model.trim());
  generatedAt = Math.max(generatedAt, Number(manifest.generatedAt || 0));
}

const entries = [...entriesByKey.values()].sort((left, right) =>
  left.parentId.localeCompare(right.parentId) || left.cardId.localeCompare(right.cardId));
const output = {
  version: 1,
  generatedAt,
  model: [...models].join(' + '),
  entries,
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ inputs: inputArgs.length, entries: entries.length })}\n`);

function groupKey(entry) {
  if (typeof entry?.parentId !== 'string' || !entry.parentId ||
      typeof entry?.cardId !== 'string' || !entry.cardId) return '';
  return `${entry.parentId}\0${entry.cardId}`;
}
