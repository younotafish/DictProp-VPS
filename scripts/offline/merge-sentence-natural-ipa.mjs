#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const [corpusArg, ipaArg, outputArg] = args;
if (!corpusArg || !ipaArg || !outputArg) {
  throw new Error('Usage: merge-sentence-natural-ipa.mjs <corpus.json> <ipa-manifest.json> <output-backfill.json> [--sentences <fresh-sentence-export.json>] [--supplemental <analysis-manifest.json>]... [--images <image-manifest.json>]');
}

const supplementalArgs = [];
let imagesArg;
let sentencesArg;
for (let index = 3; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${flag}`);
  if (flag === '--supplemental') supplementalArgs.push(value);
  else if (flag === '--images') imagesArg = value;
  else if (flag === '--sentences') sentencesArg = value;
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

const supplementalManifests = supplementalArgs.map(path => readOptionalManifest(path, 'Supplemental analysis'));
const supplemental = {
  version: 1,
  generatedAt: Math.max(0, ...supplementalManifests.map(value => Number(value.generatedAt || 0))),
  entries: supplementalManifests.flatMap(value => value.entries),
};
const images = readOptionalManifest(imagesArg, 'Image');
const supplementalById = new Map(supplemental.entries.map(entry => [entry.id, entry]));
const imageById = new Map(images.entries.map(entry => [entry.id, entry]));
const ipaById = new Map(ipa.entries.map(entry => [entry.id, entry]));
if (ipaById.size !== ipa.entries.length) throw new Error('IPA manifest contains duplicate ids');
if (supplementalById.size !== supplemental.entries.length) throw new Error('Supplemental manifests contain duplicate ids');

const corpusDataById = new Map(corpus.items
  .filter(item => item?.type === 'sentence' && !item.isDeleted)
  .map(item => [item.data?.id, item.data]));
let sentenceSources;
if (sentencesArg) {
  const fresh = JSON.parse(readFileSync(resolve(sentencesArg), 'utf8'));
  if (fresh?.version !== 1 || !Array.isArray(fresh.sentences) || fresh.sentences.length === 0) {
    throw new Error('Fresh sentence export is invalid');
  }
  sentenceSources = fresh.sentences;
} else {
  sentenceSources = [...corpusDataById.values()];
}
const sourceIds = new Set(sentenceSources.map(source => source?.id));
if (sourceIds.size !== sentenceSources.length || sourceIds.has(undefined)) throw new Error('Sentence sources contain invalid or duplicate ids');
if (ipaById.size !== sentenceSources.length) {
  throw new Error(`IPA count ${ipaById.size} does not match sentence count ${sentenceSources.length}`);
}

const generatedAt = Math.max(Date.now(), Number(ipa.generatedAt || 0), Number(supplemental.generatedAt || 0));
const entries = sentenceSources.map(source => {
  if (typeof source.text !== 'string' || !source.text.trim()) throw new Error(`Sentence has invalid text: ${source.id}`);
  const textHash = createHash('sha256').update(source.text).digest('hex');
  if (source.textHash !== undefined && source.textHash !== textHash) throw new Error(`Stale source sentence hash: ${source.id}`);
  const ipaEntry = ipaById.get(source.id);
  if (!ipaEntry || ipaEntry.textHash !== textHash || !/^\/[^/\n]+\/$/.test(ipaEntry.naturalSpeechIpa || '')) {
    throw new Error(`Missing, invalid, or stale IPA: ${source.id}`);
  }
  const supplementalEntry = supplementalById.get(source.id);
  if (supplementalEntry && supplementalEntry.textHash !== textHash) throw new Error(`Stale supplemental analysis: ${source.id}`);
  const analysis = supplementalEntry?.analysis || corpusDataById.get(source.id)?.analysis;
  if (!analysis || typeof analysis !== 'object' || typeof analysis.translation !== 'string' ||
      typeof analysis.imagePrompt !== 'string' || !Array.isArray(analysis.terms)) {
    throw new Error(`Sentence still lacks a complete analysis: ${source.id}`);
  }
  const imageEntry = imageById.get(source.id);
  if (imageEntry && imageEntry.textHash !== textHash) throw new Error(`Stale image entry: ${source.id}`);
  const result = {
    id: source.id,
    textHash,
    analysis: {
      ...analysis,
      ...(analysis.pronunciation
        ? { pronunciation: { ...analysis.pronunciation, fastIpa: ipaEntry.naturalSpeechIpa } }
        : {}),
      naturalSpeechIpa: ipaEntry.naturalSpeechIpa,
    },
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
