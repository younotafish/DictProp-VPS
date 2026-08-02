#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [sourceArg, workArg, batchSizeArg, manifestArg, remainingArg] = process.argv.slice(2);
if (!sourceArg || !workArg || !batchSizeArg || !manifestArg || !remainingArg) {
  throw new Error(
    'Usage: checkpoint-reviewed-natural-ipa.mjs <source.json> <work-dir> <batch-size> <manifest.json> <remaining-source.json>',
  );
}

const sourcePath = resolve(sourceArg);
const workDir = resolve(workArg);
const manifestPath = resolve(manifestArg);
const remainingPath = resolve(remainingArg);
const batchSize = Number(batchSizeArg);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
  throw new Error('Batch size must be an integer between 1 and 500');
}

const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
let sentences;
if (source?.version === 1 && Array.isArray(source.sentences)) {
  sentences = source.sentences;
} else if (Array.isArray(source?.items)) {
  sentences = source.items
    .filter(item => item?.type === 'sentence' && !item.isDeleted)
    .map(item => item.data);
} else {
  throw new Error('Sentence source is invalid');
}

const ids = new Set();
for (const sentence of sentences) {
  if (typeof sentence?.id !== 'string' || !sentence.id || typeof sentence.text !== 'string' || !sentence.text.trim()) {
    throw new Error('Sentence source contains an invalid record');
  }
  if (ids.has(sentence.id)) throw new Error(`Duplicate sentence id: ${sentence.id}`);
  ids.add(sentence.id);
}

const stripMarkers = text => String(text || '').replace(/\{\{|\}\}|\[\[|\]\]/g, '');
function validateIpa(value, sentence, id) {
  if (typeof value !== 'string') throw new Error(`${id}: IPA is not a string`);
  const ipa = value.trim();
  if (!/^\/[^/\n]+\/$/.test(ipa)) throw new Error(`${id}: IPA must have exactly one surrounding slash pair`);
  if (/[\[\]{}<>`]/.test(ipa)) throw new Error(`${id}: IPA contains markup`);
  if (/[0-9A-Z]/.test(ipa)) throw new Error(`${id}: IPA contains digits or uppercase spelling`);
  if (/əʊ|ɜː|ɒ/.test(ipa)) throw new Error(`${id}: IPA contains a likely non-American transcription`);
  const sourceWords = stripMarkers(sentence).match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  const ipaTokens = ipa.slice(1, -1).trim().split(/\s+/).filter(Boolean);
  if (sourceWords.length >= 6 && ipaTokens.length < Math.ceil(sourceWords.length * 0.55)) {
    throw new Error(`${id}: IPA appears incomplete`);
  }
  if (ipaTokens.length > sourceWords.length * 1.7 + 4) {
    throw new Error(`${id}: IPA has implausibly many tokens`);
  }
  return ipa;
}

const candidatesByBatch = new Map();
for (const name of readdirSync(workDir)) {
  const match = /^review-(?:codex|claude|meta)-(\d+)-[^/]+\.json$/.exec(name);
  if (!match) continue;
  const batchNumber = Number(match[1]);
  const paths = candidatesByBatch.get(batchNumber) || [];
  paths.push(join(workDir, name));
  candidatesByBatch.set(batchNumber, paths);
}
for (const paths of candidatesByBatch.values()) {
  paths.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

const generatedAt = Date.now();
const entries = [];
const completedIds = new Set();
let reviewedBatches = 0;
let invalidCandidates = 0;
const batchCount = Math.ceil(sentences.length / batchSize);
for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
  const batch = sentences.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
  const candidates = candidatesByBatch.get(batchIndex + 1) || [];
  let reviewed = null;
  for (const candidatePath of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidatePath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
        throw new Error('Wrong result count');
      }
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error('Duplicate item indexes');
      reviewed = batch.map((sentence, itemIndex) => {
        const result = byIndex.get(itemIndex);
        if (!result) throw new Error(`Missing item index ${itemIndex}`);
        return validateIpa(result.naturalSpeechIpa, sentence.text, sentence.id);
      });
      break;
    } catch {
      invalidCandidates++;
    }
  }
  if (!reviewed) continue;
  reviewedBatches++;
  for (let itemIndex = 0; itemIndex < batch.length; itemIndex++) {
    const sentence = batch[itemIndex];
    completedIds.add(sentence.id);
    entries.push({
      id: sentence.id,
      textHash: createHash('sha256').update(sentence.text).digest('hex'),
      naturalSpeechIpa: reviewed[itemIndex],
      generatedAt,
    });
  }
}

const remainingSentences = sentences.filter(sentence => !completedIds.has(sentence.id));
mkdirSync(dirname(manifestPath), { recursive: true });
mkdirSync(dirname(remainingPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify({
  version: 1,
  model: 'cross-reviewed:checkpoint',
  generatedAt,
  entries,
}, null, 2)}\n`, { mode: 0o600 });
writeFileSync(remainingPath, `${JSON.stringify({
  version: 1,
  generatedAt,
  sentences: remainingSentences,
}, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`${JSON.stringify({
  sourceSentences: sentences.length,
  reviewedBatches,
  reviewedSentences: entries.length,
  remainingSentences: remainingSentences.length,
  invalidCandidates,
}, null, 2)}\n`);
