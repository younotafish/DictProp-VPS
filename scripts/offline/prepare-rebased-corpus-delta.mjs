#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [productionArg, baseArg, targetArg, outputArg] = process.argv.slice(2);
if (!productionArg || !baseArg || !targetArg || !outputArg) {
  throw new Error('Usage: prepare-rebased-corpus-delta.mjs <production-export.json> <base-manifest.json> <target-manifest.json> <output.json>');
}

const production = readJson(productionArg);
const base = readJson(baseArg);
const target = readJson(targetArg);
if (!Array.isArray(production?.items) || !Array.isArray(base?.entries) || !Array.isArray(target?.entries)) {
  throw new Error('Production export, base manifest, or target manifest is invalid');
}
const productionById = uniqueMap(production.items, 'production item');
const baseById = uniqueMap(base.entries, 'base entry');
const targetById = uniqueMap(target.entries, 'target entry');

const entries = [];
const conflicts = [];
let unchangedDesired = 0;
let alreadyApplied = 0;
let missingProduction = 0;

for (const targetEntry of target.entries) {
  const baseEntry = baseById.get(targetEntry.id);
  if (!baseEntry || baseEntry.type !== targetEntry.type) {
    conflicts.push({ id: targetEntry.id, reason: 'target has no matching base identity' });
    continue;
  }
  const baseHash = corpusHash(baseEntry.data);
  const targetHash = corpusHash(targetEntry.data);
  if (baseHash === targetHash) {
    unchangedDesired++;
    continue;
  }
  const current = productionById.get(targetEntry.id);
  if (!current || current.type !== targetEntry.type) {
    missingProduction++;
    continue;
  }
  const currentHash = corpusHash(current.data);
  if (currentHash === targetHash) {
    alreadyApplied++;
    continue;
  }
  if (currentHash !== baseHash) {
    conflicts.push({ id: targetEntry.id, reason: 'production differs from both the reviewed base and target' });
    continue;
  }
  entries.push({
    ...structuredClone(targetEntry),
    sourceHash: currentHash,
    wasArchived: current.wasArchived === true,
  });
}

if (conflicts.length > 0) {
  process.stderr.write(`${JSON.stringify({ conflicts: conflicts.slice(0, 100) }, null, 2)}\n`);
  process.exitCode = 1;
} else if (entries.length === 0) {
  throw new Error('No rebased corpus delta remains to publish');
} else {
  const output = {
    version: 1,
    generatedAt: target.generatedAt,
    model: target.model,
    entries,
  };
  const outputPath = resolve(outputArg);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
}

process.stdout.write(`${JSON.stringify({
  productionRecords: production.items.length,
  baseRecords: base.entries.length,
  targetRecords: target.entries.length,
  unchangedDesired,
  alreadyApplied,
  missingProduction,
  rebasedEntries: entries.length,
  conflicts: conflicts.length,
}, null, 2)}\n`);

function corpusHash(data) {
  const stable = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'analysis' && key !== 'analysisGeneratedAt'))
    : data;
  return createHash('sha256').update(JSON.stringify(withoutImages(stable))).digest('hex');
}

function withoutImages(value) {
  if (Array.isArray(value)) return value.map(withoutImages);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImages(child)]));
}

function uniqueMap(values, label) {
  const map = new Map();
  for (const value of values) {
    if (typeof value?.id !== 'string' || !value.id || map.has(value.id)) {
      throw new Error(`${label} has an invalid or duplicate id: ${value?.id || '<empty>'}`);
    }
    map.set(value.id, value);
  }
  return map;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}
