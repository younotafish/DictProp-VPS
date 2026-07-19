#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const [corpusArg, ipaArg, outputArg] = args;
if (!corpusArg || !ipaArg || !outputArg) {
  throw new Error('Usage: merge-sentence-natural-ipa.mjs <corpus.json> <ipa-manifest.json> <output-backfill.json> [--supplemental <analysis-manifest.json>] [--images <image-manifest.json>]');
}

let supplementalArg;
let imagesArg;
for (let index = 3; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${flag}`);
  if (flag === '--supplemental') supplementalArg = value;
  else if (flag === '--images') imagesArg = value;
  else throw new Error(`Unknown option: ${flag}`);
}

const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
const ipa = JSON.parse(readFileSync(resolve(ipaArg), 'utf8'));
if (!Array.isArray(corpus?.items) || ipa?.version !== 1 || !Array.isArray(ipa.entries)) {
  throw new Error('Corpus or IPA manifest is invalid');
}

function readOptionalManifest(path, label) {
  if (!path) return { version: 1, generatedAt: 0, entries: [] };
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.entries)) throw new Error(`${label} manifest is invalid`);
  return value;
}

const supplemental = readOptionalManifest(supplementalArg, 'Supplemental analysis');
const images = readOptionalManifest(imagesArg, 'Image');
const supplementalById = new Map(supplemental.entries.map(entry => [entry.id, entry]));
const imageById = new Map(images.entries.map(entry => [entry.id, entry]));
const ipaById = new Map(ipa.entries.map(entry => [entry.id, entry]));
if (ipaById.size !== ipa.entries.length) throw new Error('IPA manifest contains duplicate ids');

const sentenceItems = corpus.items.filter(item => item?.type === 'sentence' && !item.isDeleted);
if (ipaById.size !== sentenceItems.length) {
  throw new Error(`IPA count ${ipaById.size} does not match sentence count ${sentenceItems.length}`);
}

const generatedAt = Math.max(Date.now(), Number(ipa.generatedAt || 0), Number(supplemental.generatedAt || 0));
const entries = sentenceItems.map(item => {
  const data = item.data || {};
  const textHash = createHash('sha256').update(data.text || '').digest('hex');
  const ipaEntry = ipaById.get(data.id);
  if (!ipaEntry || ipaEntry.textHash !== textHash || !/^\/[^/\n]+\/$/.test(ipaEntry.naturalSpeechIpa || '')) {
    throw new Error(`Missing, invalid, or stale IPA: ${data.id}`);
  }
  const supplementalEntry = supplementalById.get(data.id);
  if (supplementalEntry && supplementalEntry.textHash !== textHash) throw new Error(`Stale supplemental analysis: ${data.id}`);
  const analysis = data.analysis || supplementalEntry?.analysis;
  if (!analysis || typeof analysis !== 'object' || typeof analysis.translation !== 'string' ||
      typeof analysis.imagePrompt !== 'string' || !Array.isArray(analysis.terms)) {
    throw new Error(`Sentence still lacks a complete analysis: ${data.id}`);
  }
  const imageEntry = imageById.get(data.id);
  if (imageEntry && imageEntry.textHash !== textHash) throw new Error(`Stale image entry: ${data.id}`);
  const result = {
    id: data.id,
    textHash,
    analysis: { ...analysis, naturalSpeechIpa: ipaEntry.naturalSpeechIpa },
    generatedAt,
  };
  if (imageEntry?.imageFile) {
    result.imageFile = imageEntry.imageFile;
    if (imageEntry.replaceImage !== undefined) result.replaceImage = imageEntry.replaceImage;
  }
  return result;
});

for (const entry of supplemental.entries) {
  if (!entries.some(candidate => candidate.id === entry.id)) throw new Error(`Supplemental analysis has unknown id: ${entry.id}`);
}
for (const entry of images.entries) {
  if (!entries.some(candidate => candidate.id === entry.id)) throw new Error(`Image manifest has unknown id: ${entry.id}`);
}

writeFileSync(resolve(outputArg), `${JSON.stringify({ version: 1, generatedAt, entries }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Merged ${entries.length} sentence analyses with reviewed natural IPA\n`);

