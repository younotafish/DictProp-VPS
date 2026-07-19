#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [baseDirArg, incrementalTargetsArg, additionDirArg] = process.argv.slice(2);
if (!baseDirArg || !incrementalTargetsArg || !additionDirArg) {
  throw new Error('Usage: extend-sentence-image-backfill.mjs <base-output-directory> <incremental-targets.json> <addition-output-directory>');
}

const baseDir = resolve(baseDirArg);
const additionDir = resolve(additionDirArg);
const baseTargetsPath = join(baseDir, 'targets.json');
const baseManifestPath = join(baseDir, 'manifest.json');
const additionTargetsPath = join(additionDir, 'targets.json');
const additionManifestPath = join(additionDir, 'manifest.json');
const incrementalPath = resolve(incrementalTargetsArg);

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const baseTargets = readJson(baseTargetsPath);
const baseManifest = readJson(baseManifestPath);
const additionTargets = readJson(additionTargetsPath);
const additionManifest = readJson(additionManifestPath);
const incrementalTargets = readJson(incrementalPath);
for (const [label, value, field] of [
  ['base targets', baseTargets, 'targets'],
  ['base manifest', baseManifest, 'entries'],
  ['addition targets', additionTargets, 'targets'],
  ['addition manifest', additionManifest, 'entries'],
  ['incremental targets', incrementalTargets, 'targets'],
]) {
  if (value?.version !== 1 || !Array.isArray(value[field])) throw new Error(`${label} is invalid`);
}

function mergeById(base, additions, idField, label) {
  const byId = new Map(base.map(entry => [entry[idField], entry]));
  if (byId.size !== base.length) throw new Error(`${label} contains duplicate ids before merge`);
  let added = 0;
  for (const entry of additions) {
    const id = entry[idField];
    if (typeof id !== 'string' || !id) throw new Error(`${label} addition has an invalid id`);
    const existing = byId.get(id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error(`${label} has a conflicting entry for ${id}`);
      continue;
    }
    base.push(entry);
    byId.set(id, entry);
    added++;
  }
  return added;
}

const targetsAdded = mergeById(baseTargets.targets, additionTargets.targets, 'imageId', 'base targets');
const entriesAdded = mergeById(baseManifest.entries, additionManifest.entries, 'id', 'base manifest');
const incrementalAdded = mergeById(incrementalTargets.targets, additionTargets.targets, 'imageId', 'incremental targets');
if (targetsAdded !== entriesAdded) throw new Error('Target and manifest additions do not match');

const generatedAt = Math.max(
  Date.now(),
  Number(baseTargets.generatedAt || 0),
  Number(baseManifest.generatedAt || 0),
  Number(additionTargets.generatedAt || 0),
  Number(additionManifest.generatedAt || 0),
);
baseTargets.generatedAt = generatedAt;
baseManifest.generatedAt = generatedAt;
incrementalTargets.generatedAt = generatedAt;
writeFileSync(baseTargetsPath, `${JSON.stringify(baseTargets, null, 2)}\n`, { mode: 0o600 });
writeFileSync(baseManifestPath, `${JSON.stringify(baseManifest, null, 2)}\n`, { mode: 0o600 });
writeFileSync(incrementalPath, `${JSON.stringify(incrementalTargets, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Added ${targetsAdded} final targets, ${entriesAdded} manifest entries, and ${incrementalAdded} incremental targets\n`);

