#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [sourceArg, manifestArg, adjudicationArg] = process.argv.slice(2);
if (!sourceArg || !manifestArg) {
  throw new Error('Usage: verify-regenerated-metadata.mjs <corpus-export.json> <regenerated-manifest.json> [usage-adjudication.json]');
}

const source = JSON.parse(readFileSync(resolve(sourceArg), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(manifestArg), 'utf8'));
const adjudication = adjudicationArg ? JSON.parse(readFileSync(resolve(adjudicationArg), 'utf8')) : null;
if (!Array.isArray(source?.items) || !Array.isArray(manifest?.entries)) {
  throw new Error('Source export or regenerated manifest is invalid');
}
if (adjudication && !Array.isArray(adjudication.entries)) throw new Error('Usage adjudication is invalid');
const lexicalCorrections = new Map();
for (const entry of adjudication?.entries || []) {
  if (entry.decision?.lexicalAction !== 'correct') continue;
  if (lexicalCorrections.has(entry.cardId) || typeof entry.decision.correctedWord !== 'string' ||
      typeof entry.decision.correctedSense !== 'string') {
    throw new Error(`Usage adjudication has an invalid lexical correction: ${entry.cardId}`);
  }
  lexicalCorrections.set(entry.cardId, entry.decision);
}

const statuses = ['modern_american', 'current_general', 'narrow_specialized', 'british_only', 'rare_or_dated'];
const confidences = ['high', 'medium', 'low'];
const usagePriority = new Map(statuses.map((status, index) => [status, index]));
const failures = [];
const fail = (id, message) => failures.push({ id, message });
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);

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

function lexicalKey(word, sense) {
  return `${normalizedSentence(word)}\u0000${normalizedSentence(sense)}`;
}

function validAudit(value) {
  return isRecord(value) && statuses.includes(value.status) && confidences.includes(value.confidence) &&
    typeof value.reason === 'string' && value.reason.trim().length >= 15 &&
    Number.isFinite(value.auditedAt) && value.auditedAt > 0;
}

function markerError(example) {
  if (typeof example !== 'string' || example.trim().length < 20) return 'example is empty or too short';
  const targets = [...example.matchAll(/\{\{([^{}]+)\}\}/g)];
  const lookups = [...example.matchAll(/\[\[([^\[\]]+)\]\]/g)];
  if (targets.length !== 1 || !targets[0][1].trim()) return 'example lacks exactly one {{studied target}} marker';
  if (/\[\[|\]\]/.test(targets[0][1])) return 'example nests a lookup marker inside the studied target';
  if (lookups.length > 4 || lookups.some(match => !match[1].trim())) return 'example has invalid [[lookup]] markers';
  const remainder = example.replace(/\{\{[^{}]+\}\}/g, '').replace(/\[\[[^\[\]]+\]\]/g, '');
  if (/[{}[\]]/.test(remainder)) return 'example has unbalanced marker syntax';
  return null;
}

function protectedExamplesFor(card, savedTextSet, linkedSentences) {
  const output = [];
  const seen = new Set();
  for (const example of Array.isArray(card.examples) ? card.examples : []) {
    const key = normalizedSentence(example);
    if (key && savedTextSet.has(key) && !seen.has(key)) {
      output.push(example);
      seen.add(key);
    }
  }
  for (const sentence of linkedSentences.get(lexicalKey(card.word, card.sense)) || []) {
    const key = normalizedSentence(sentence);
    if (key && !seen.has(key)) {
      output.push(sentence);
      seen.add(key);
    }
  }
  return output;
}

function cardError(card) {
  if (!isRecord(card) || typeof card.id !== 'string' || typeof card.word !== 'string' || !card.word.trim()) {
    return 'card identity is invalid';
  }
  for (const [field, minimum] of [
    ['sense', 3], ['chinese', 1], ['definition', 10], ['history', 20],
    ['register', 10], ['mnemonic', 10], ['imagePrompt', 50],
  ]) {
    if (typeof card[field] !== 'string' || card[field].trim().length < minimum) return `${field} is incomplete`;
  }
  if (typeof card.ipa !== 'string' || !card.ipa.startsWith('/') || !card.ipa.endsWith('/')) {
    return 'American IPA is invalid';
  }
  if (!/[\u3400-\u9fff]/u.test(card.chinese)) return 'Chinese translation has no Chinese characters';
  for (const field of ['forms', 'wordFamily', 'synonyms', 'antonyms', 'confusables', 'examples']) {
    if (!Array.isArray(card[field])) return `${field} is not an array`;
  }
  if (card.examples.length === 0) return 'examples are empty';
  if (!validAudit(card.usageAudit)) return 'usage audit is invalid';
  return null;
}

const sourceById = new Map(source.items.map(item => [item.id, item]));
const targetById = new Map(manifest.entries.map(entry => [entry.id, entry]));
if (sourceById.size !== source.items.length) throw new Error('Source has duplicate ids');
if (targetById.size !== manifest.entries.length) throw new Error('Manifest has duplicate ids');

const savedSentences = source.items.filter(item => item.type === 'sentence').map(item => item.data);
const savedTextSet = new Set(savedSentences.map(sentence => normalizedSentence(sentence.text)).filter(Boolean));
const linkedSentences = new Map();
for (const sentence of savedSentences) {
  const key = lexicalKey(sentence.sourceWord, sentence.sourceSense);
  if (!linkedSentences.has(key)) linkedSentences.set(key, []);
  linkedSentences.get(key).push(sentence.text);
}

let cards = 0;
let phrases = 0;
let sentences = 0;
let protectedExamples = 0;
let generatedExamples = 0;
let changedSentenceSenseLinks = 0;
const topLevelSenseKeys = new Map();

for (const sourceItem of source.items) {
  const entry = targetById.get(sourceItem.id);
  if (!entry) {
    fail(sourceItem.id, 'record is missing from regenerated manifest');
    continue;
  }
  if (entry.type !== sourceItem.type || entry.data?.id !== sourceItem.id || entry.sourceHash !== sourceItem.sourceHash) {
    fail(sourceItem.id, 'record identity, type, or source hash changed');
    continue;
  }
  if (entry.wasArchived !== (sourceItem.wasArchived === true)) fail(sourceItem.id, 'archive history changed');
  if (typeof entry.archiveForUsage !== 'boolean') fail(sourceItem.id, 'archiveForUsage is missing');

  if (sourceItem.type === 'sentence') {
    sentences++;
    const before = structuredClone(sourceItem.data);
    const after = structuredClone(entry.data);
    if (before.text !== after.text) fail(sourceItem.id, 'saved sentence text changed');
    if (before.sourceSense !== after.sourceSense) changedSentenceSenseLinks++;
    delete before.sourceSense;
    delete after.sourceSense;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail(sourceItem.id, 'saved sentence metadata changed outside sourceSense relinking');
    }
    continue;
  }

  const validateCard = (sourceCard, targetCard, context) => {
    cards++;
    const protectedList = protectedExamplesFor(sourceCard, savedTextSet, linkedSentences);
    const correction = lexicalCorrections.get(sourceCard.id);
    const expectedWord = correction && protectedList.length === 0 ? correction.correctedWord : sourceCard.word;
    const expectedSense = correction && protectedList.length === 0 ? correction.correctedSense : targetCard?.sense;
    if (!targetCard || targetCard.id !== sourceCard.id || targetCard.word !== expectedWord ||
        (correction && protectedList.length === 0 && targetCard.sense !== expectedSense)) {
      fail(context, 'card id or headword changed');
      return;
    }
    if ((sourceCard.imageUrl ?? null) !== (targetCard.imageUrl ?? null)) fail(context, 'image marker changed');
    const structuralError = cardError(targetCard);
    if (structuralError) fail(context, structuralError);
    if (process.env.ALLOW_REDUNDANT_FORMS !== '1' &&
        (targetCard.forms || []).some(form => normalizedSentence(form) === normalizedSentence(targetCard.word))) {
      fail(context, 'forms repeats the unchanged headword');
    }
    const targetExamples = new Set(targetCard.examples || []);
    if (protectedList.length > 0) {
      protectedExamples += (sourceCard.examples || []).length;
      if (JSON.stringify(targetCard.examples || []) !== JSON.stringify(sourceCard.examples || [])) {
        fail(context, 'meaning linked to a saved sentence did not preserve its complete example list exactly');
      }
      return;
    }
    const protectedSet = new Set(protectedList);
    for (const example of protectedList) {
      protectedExamples++;
      if (!targetExamples.has(example)) fail(context, `protected example was not preserved exactly: ${example.slice(0, 120)}`);
    }
    const normalized = new Set();
    for (const example of targetCard.examples || []) {
      const key = normalizedSentence(example);
      if (normalized.has(key)) fail(context, 'examples contain a normalized duplicate');
      normalized.add(key);
      if (!protectedSet.has(example)) {
        generatedExamples++;
        const error = markerError(example);
        if (error) fail(context, error);
      }
    }
  };

  if (sourceItem.type === 'vocab') {
    validateCard(sourceItem.data, entry.data, sourceItem.id);
    const senseKey = lexicalKey(entry.data.word, entry.data.sense);
    const existing = topLevelSenseKeys.get(senseKey);
    if (existing) fail(sourceItem.id, `duplicates regenerated sense identity from ${existing}`);
    else topLevelSenseKeys.set(senseKey, sourceItem.id);
  } else {
    phrases++;
    if (entry.data.query !== sourceItem.data.query || entry.data.id !== sourceItem.data.id) {
      fail(sourceItem.id, 'phrase identity or query changed');
    }
    if ((sourceItem.data.imageUrl ?? null) !== (entry.data.imageUrl ?? null)) fail(sourceItem.id, 'phrase image marker changed');
    for (const [field, minimum] of [
      ['translation', 1], ['grammar', 20], ['visualKeyword', 1], ['imagePrompt', 50],
    ]) {
      if (typeof entry.data[field] !== 'string' || entry.data[field].trim().length < minimum) {
        fail(sourceItem.id, `phrase ${field} is incomplete`);
      }
    }
    if (typeof entry.data.pronunciation !== 'string' || !entry.data.pronunciation.startsWith('/') ||
        !entry.data.pronunciation.endsWith('/')) {
      fail(sourceItem.id, 'phrase pronunciation is invalid');
    }
    if (!validAudit(entry.data.usageAudit)) fail(sourceItem.id, 'phrase usage audit is invalid');
    const sourceCards = new Map((sourceItem.data.vocabs || []).map(card => [card.id, card]));
    const targetCards = new Map((entry.data.vocabs || []).map(card => [card.id, card]));
    if (sourceCards.size !== targetCards.size || sourceCards.size !== (sourceItem.data.vocabs || []).length) {
      fail(sourceItem.id, 'phrase card count or identities changed');
    }
    for (const [id, sourceCard] of sourceCards) validateCard(sourceCard, targetCards.get(id), `${sourceItem.id}/${id}`);
    let previousRank = -1;
    for (const card of entry.data.vocabs || []) {
      const rank = usagePriority.get(card.usageAudit?.status) ?? 99;
      if (rank < previousRank) fail(sourceItem.id, 'phrase cards are not ordered by learner value');
      previousRank = rank;
    }
  }
}

for (const entry of manifest.entries) {
  if (!sourceById.has(entry.id)) fail(entry.id, 'unexpected extra regenerated record');
}

const report = {
  sourceRecords: source.items.length,
  targetRecords: manifest.entries.length,
  cards,
  phrases,
  sentences,
  protectedExamples,
  generatedExamples,
  changedSentenceSenseLinks,
  failureCount: failures.length,
  failures: failures.slice(0, 300),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
