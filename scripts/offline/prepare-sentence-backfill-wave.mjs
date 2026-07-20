#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const [sourceArg, outputArg, ...excludeArgs] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error('Usage: prepare-sentence-backfill-wave.mjs <source-directory> <output-directory> [published-manifest.json ...]');
}

const sourceDir = resolve(sourceArg);
const outputDir = resolve(outputArg);
const manifestPath = join(sourceDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
  throw new Error('Source sentence backfill manifest is invalid or empty');
}

const publishedIds = new Set();
for (const excludeArg of excludeArgs) {
  const excludePath = resolve(excludeArg);
  const published = JSON.parse(readFileSync(excludePath, 'utf8'));
  if (published?.version !== 1 || !Array.isArray(published.entries)) {
    throw new Error(`Published manifest is invalid: ${excludePath}`);
  }
  for (const entry of published.entries) {
    if (typeof entry?.id !== 'string' || !entry.id) {
      throw new Error(`Published manifest contains an invalid entry: ${excludePath}`);
    }
    publishedIds.add(entry.id);
  }
}

const sourceIds = new Set();
const selected = [];
for (const entry of manifest.entries) {
  if (typeof entry?.id !== 'string' || !entry.id || sourceIds.has(entry.id)) {
    throw new Error(`Source manifest contains an invalid or duplicate id: ${String(entry?.id)}`);
  }
  sourceIds.add(entry.id);
  if (publishedIds.has(entry.id)) continue;
  if (typeof entry.imageFile !== 'string' || !entry.imageFile.startsWith('images/')) continue;
  const sourceImage = resolve(sourceDir, entry.imageFile);
  if (!sourceImage.startsWith(`${sourceDir}/`) || !existsSync(sourceImage)) continue;
  const naturalSpeechIpa = entry.analysis?.naturalSpeechIpa;
  if (typeof naturalSpeechIpa !== 'string' || !/^\/[^/\n]+\/$/.test(naturalSpeechIpa)) {
    throw new Error(`Sentence ${entry.id} is missing natural-speech IPA`);
  }
  selected.push(entry);
}

mkdirSync(join(outputDir, 'images'), { recursive: true });
for (const entry of selected) {
  const sourceImage = resolve(sourceDir, entry.imageFile);
  const destination = join(outputDir, 'images', basename(entry.imageFile));
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) continue;
  try {
    linkSync(sourceImage, destination);
  } catch {
    copyFileSync(sourceImage, destination);
  }
}

const waveManifest = {
  ...manifest,
  generatedAt: Date.now(),
  entries: selected,
};
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(waveManifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  sourceEntries: manifest.entries.length,
  previouslyPublished: publishedIds.size,
  waveEntries: selected.length,
})}\n`);
