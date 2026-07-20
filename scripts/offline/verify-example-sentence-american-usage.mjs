#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [sourceArg, analysisArg, overridesArg, usageAdjudicationArg, corpusArg] = process.argv.slice(2);
if (!sourceArg || !analysisArg || !overridesArg || !usageAdjudicationArg || !corpusArg) {
  throw new Error('Usage: verify-example-sentence-american-usage.mjs <sentence-source.json> <analysis.json> <american-status-overrides.json> <usage-adjudication.json> <corpus-manifest.json>');
}

const source = readJson(sourceArg);
const analysis = readJson(analysisArg);
const overrides = readJson(overridesArg);
const usageAdjudication = readJson(usageAdjudicationArg);
const corpus = readJson(corpusArg);
if (!Array.isArray(source?.sentences) || !Array.isArray(analysis?.entries) ||
    !Array.isArray(overrides?.entries) || !Array.isArray(usageAdjudication?.entries) ||
    !Array.isArray(corpus?.entries)) {
  throw new Error('One or more American-usage verification inputs are invalid');
}

const sourceById = uniqueMap(source.sentences, 'source sentence');
const analysisById = uniqueMap(analysis.entries, 'analysis');
const overrideById = uniqueMap(overrides.entries, 'American-status override');
const corpusById = uniqueMap(corpus.entries, 'corpus entry');
const savedSentences = corpus.entries.filter(entry => entry.type === 'sentence');
const savedTexts = new Set(savedSentences.map(entry => normalizedSentence(entry.data?.text)).filter(Boolean));
const savedLexicalKeys = new Set(savedSentences
  .map(entry => lexicalKey(entry.data?.sourceWord, entry.data?.sourceSense))
  .filter(Boolean));
const adjudicationByExampleId = new Map();
for (const group of usageAdjudication.entries) {
  for (let index = 0; index < (group.examples || []).length; index++) {
    const example = group.examples[index];
    if (adjudicationByExampleId.has(example.id)) {
      throw new Error(`Usage adjudication contains duplicate example id: ${example.id}`);
    }
    adjudicationByExampleId.set(example.id, { group, decision: group.decision?.examples?.[index] });
  }
}
const failures = [];
let notAmerican = 0;
let archivedUsage = 0;
let adjudicatedSpecialized = 0;
let protectedMeaningExceptions = 0;

for (const sentence of source.sentences) {
  const entry = analysisById.get(sentence.id);
  if (!entry || entry.textHash !== sentence.textHash) {
    failures.push({ id: sentence.id, reason: 'analysis identity or text hash does not match the source' });
    continue;
  }
  if (entry.analysis?.americanEnglish?.status !== 'not_american') continue;
  notAmerican++;
  const provenance = sentence.provenance || [];
  const statuses = new Set(provenance.map(value => value.usageStatus || 'unknown'));
  const adjudication = adjudicationByExampleId.get(sentence.id);
  const protectedConflict = adjudication && ['rewrite', 'remove'].includes(adjudication.decision?.action) &&
    provenance.some(value => value.parentId === adjudication.group.parentId &&
      value.cardId === adjudication.group.cardId && meaningIsProtected(value));
  if (protectedConflict) {
    protectedMeaningExceptions++;
    continue;
  }
  if (statuses.has('modern_american') || statuses.has('current_general')) {
    failures.push({
      id: sentence.id,
      reason: 'a modern/current meaning still uses a sentence judged non-American',
      statuses: [...statuses],
    });
    continue;
  }
  if (statuses.has('narrow_specialized')) {
    const override = overrideById.get(sentence.id);
    if (override?.textHash !== sentence.textHash || override.americanEnglish?.status !== 'not_american') {
      failures.push({
        id: sentence.id,
        reason: 'a specialized non-American sentence lacks an independent final dialect adjudication',
        statuses: [...statuses],
      });
      continue;
    }
    adjudicatedSpecialized++;
    continue;
  }
  if ([...statuses].some(status => !['british_only', 'rare_or_dated'].includes(status))) {
    failures.push({
      id: sentence.id,
      reason: 'a non-American sentence has unknown or unsupported usage provenance',
      statuses: [...statuses],
    });
    continue;
  }
  archivedUsage++;
}

for (const entry of analysis.entries) {
  if (!sourceById.has(entry.id)) failures.push({ id: entry.id, reason: 'analysis is outside the sentence source' });
}

const report = {
  sourceSentences: source.sentences.length,
  analyses: analysis.entries.length,
  notAmerican,
  archivedUsage,
  adjudicatedSpecialized,
  protectedMeaningExceptions,
  failures: failures.length,
  failureSample: failures.slice(0, 100),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;

function meaningIsProtected(provenance) {
  const record = corpusById.get(provenance.parentId);
  const card = record?.type === 'vocab'
    ? record.data
    : (record?.data?.vocabs || []).find(value => value.id === provenance.cardId);
  if (!card) return false;
  return savedLexicalKeys.has(lexicalKey(card.word, card.sense)) ||
    (card.examples || []).some(example => savedTexts.has(normalizedSentence(example)));
}

function lexicalKey(word, sense) {
  return `${normalizedSentence(word)}\0${normalizedSentence(sense)}`;
}

function normalizedSentence(value) {
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

function uniqueMap(entries, label) {
  const map = new Map();
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || !entry.id || map.has(entry.id)) {
      throw new Error(`${label} has an invalid or duplicate id: ${entry?.id || '<empty>'}`);
    }
    map.set(entry.id, entry);
  }
  return map;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}
