#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isDetailedSentenceAnalysis } from './sentence-analysis-contract.mjs';

const [sourceArg, analysisArg, imageBundleArg] = process.argv.slice(2);
if (!sourceArg || !analysisArg) {
  throw new Error('Usage: verify-example-sentence-pool.mjs <source.json> <analysis.json> [image-bundle-directory]');
}

const source = readJson(sourceArg);
const analysis = readJson(analysisArg);
if (source?.version !== 1 || !Array.isArray(source.sentences) || source.sentences.length === 0) {
  throw new Error('Sentence pool source is invalid or empty');
}
if (analysis?.version !== 1 || !Array.isArray(analysis.entries)) {
  throw new Error('Sentence pool analysis manifest is invalid');
}

const sourceById = new Map();
const sourceByLookupHash = new Map();
for (const sentence of source.sentences) {
  assertString(sentence?.id, 'sentence id');
  assertString(sentence?.text, `${sentence.id}: text`);
  assertString(sentence?.textHash, `${sentence.id}: textHash`);
  assertString(sentence?.lookupHash, `${sentence.id}: lookupHash`);
  if (sourceById.has(sentence.id)) throw new Error(`Duplicate source id: ${sentence.id}`);
  if (sourceByLookupHash.has(sentence.lookupHash)) throw new Error(`Duplicate lookup hash: ${sentence.lookupHash}`);
  if (sentence.id !== `example-${sentence.lookupHash.slice(0, 40)}`) {
    throw new Error(`${sentence.id}: id does not match lookup hash`);
  }
  if (sha256(sentence.text) !== sentence.textHash) throw new Error(`${sentence.id}: text hash mismatch`);
  if (sha256(normalizeSentence(sentence.text)) !== sentence.lookupHash) {
    throw new Error(`${sentence.id}: normalized lookup hash mismatch`);
  }
  if (!Array.isArray(sentence.provenance) || sentence.provenance.length === 0) {
    throw new Error(`${sentence.id}: missing provenance`);
  }
  sourceById.set(sentence.id, sentence);
  sourceByLookupHash.set(sentence.lookupHash, sentence);
}

const analysisById = new Map();
for (const entry of analysis.entries) {
  assertString(entry?.id, 'analysis id');
  if (analysisById.has(entry.id)) throw new Error(`Duplicate analysis id: ${entry.id}`);
  const sentence = sourceById.get(entry.id);
  if (!sentence) throw new Error(`Analysis has no source sentence: ${entry.id}`);
  if (entry.textHash !== sentence.textHash) throw new Error(`${entry.id}: analysis text hash mismatch`);
  validateAnalysis(entry.analysis, entry.id);
  analysisById.set(entry.id, entry);
}
if (analysisById.size !== sourceById.size) {
  const missing = [...sourceById.keys()].filter(id => !analysisById.has(id));
  throw new Error(`Analysis coverage mismatch: ${analysisById.size}/${sourceById.size}; missing ${missing.slice(0, 5).join(', ')}`);
}

let imageBytes = 0;
let imageCount = 0;
if (imageBundleArg) {
  const imageBundleDir = resolve(imageBundleArg);
  const targets = readJson(join(imageBundleDir, 'targets.json'));
  const manifest = readJson(join(imageBundleDir, 'manifest.json'));
  if (!Array.isArray(targets?.targets) || !Array.isArray(manifest?.entries)) {
    throw new Error('Image target or bundle manifest is invalid');
  }
  const targetsById = new Map();
  for (const target of targets.targets) {
    const sentence = sourceById.get(target?.imageId);
    if (!sentence) throw new Error(`Image target has no source: ${target?.imageId}`);
    if (targetsById.has(target.imageId)) throw new Error(`Duplicate image target: ${target.imageId}`);
    const expectedFilename = `${sha256(target.imageId).slice(0, 32)}.webp`;
    if (target.filename !== expectedFilename) throw new Error(`${target.imageId}: unexpected image filename`);
    if (target.prompt !== analysisById.get(target.imageId).analysis.imagePrompt) {
      throw new Error(`${target.imageId}: image prompt differs from sentence analysis`);
    }
    targetsById.set(target.imageId, target);
  }
  if (targetsById.size !== sourceById.size) throw new Error('Image target coverage mismatch');
  const targetFilenames = new Set([...targetsById.values()].map(target => target.filename));

  const manifestById = new Map();
  for (const entry of manifest.entries) {
    if (manifestById.has(entry.id)) throw new Error(`Duplicate image manifest entry: ${entry.id}`);
    const sourceEntry = sourceById.get(entry.id);
    const target = targetsById.get(entry.id);
    if (!sourceEntry || !target || entry.textHash !== sourceEntry.textHash) {
      throw new Error(`${entry.id}: image manifest identity mismatch`);
    }
    if (entry.imageFile !== `images/${target.filename}`) throw new Error(`${entry.id}: unsafe image path`);
    const imagePath = join(imageBundleDir, entry.imageFile);
    if (!existsSync(imagePath)) throw new Error(`${entry.id}: image file is missing`);
    const image = readFileSync(imagePath);
    if (image.length < 12 || image.length > 10 * 1024 * 1024 ||
        image.toString('ascii', 0, 4) !== 'RIFF' || image.toString('ascii', 8, 12) !== 'WEBP') {
      throw new Error(`${entry.id}: image is not a valid bounded WebP file`);
    }
    imageBytes += image.length;
    imageCount++;
    manifestById.set(entry.id, entry);
  }
  if (manifestById.size !== sourceById.size) throw new Error('Image manifest coverage mismatch');

  const actualFiles = readdirSync(join(imageBundleDir, 'images')).filter(name => name.endsWith('.webp'));
  if (actualFiles.length !== imageCount) throw new Error('Image directory contains missing or extra WebP files');
  for (const filename of actualFiles) {
    if (!targetFilenames.has(basename(filename))) {
      throw new Error(`Unexpected image file: ${filename}`);
    }
  }
}

const analysisBytes = statSync(resolve(analysisArg)).size;
process.stdout.write(`${JSON.stringify({
  sourceSentences: sourceById.size,
  analyses: analysisById.size,
  analysisBytes,
  averageAnalysisBytes: Math.round(analysisBytes / analysisById.size),
  images: imageCount,
  imageBytes,
  averageImageBytes: imageCount ? Math.round(imageBytes / imageCount) : 0,
  verified: true,
}, null, 2)}\n`);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeSentence(value) {
  return String(value || '')
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is invalid`);
}

function validateAnalysis(value, id) {
  if (!isDetailedSentenceAnalysis(value)) throw new Error(`${id}: detailed sentence analysis is incomplete`);
  assertString(value?.translation, `${id}: translation`);
  const fluentIpa = value.naturalSpeechIpa || value.pronunciation.fastIpa;
  assertString(fluentIpa, `${id}: fluent IPA`);
  if (!/^\/[^/]+\/$/.test(fluentIpa.trim())) throw new Error(`${id}: fluent IPA is invalid`);
  assertString(value?.imagePrompt, `${id}: imagePrompt`);
  if (!value?.americanEnglish || !['american', 'shared', 'not_american'].includes(value.americanEnglish.status)) {
    throw new Error(`${id}: American English status is invalid`);
  }
  assertString(value.americanEnglish.explanation, `${id}: American English explanation`);
  if (!Array.isArray(value.terms) || value.terms.length > 20) throw new Error(`${id}: terms are invalid`);
  for (const term of value.terms) {
    for (const field of ['term', 'chinese', 'ipa', 'originalMeaning', 'historicalEvolution']) {
      assertString(term?.[field], `${id}: term ${field}`);
    }
    if (!Array.isArray(term.synonyms) || term.synonyms.length === 0 ||
        !Array.isArray(term.antonyms) || !Array.isArray(term.examples) || term.examples.length < 2) {
      throw new Error(`${id}: term arrays are invalid`);
    }
  }
}
