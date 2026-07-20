#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [corpusArg, sourceArg, adjudicationArg, outputArg] = process.argv.slice(2);
if (!corpusArg || !sourceArg || !adjudicationArg || !outputArg) {
  throw new Error('Usage: apply-sentence-usage-adjudications.mjs <corpus-manifest.json> <sentence-source.json> <adjudication.json> <output-manifest.json>');
}

const corpus = readJson(corpusArg);
const source = readJson(sourceArg);
const adjudication = readJson(adjudicationArg);
if (!Array.isArray(corpus?.entries) || !Array.isArray(source?.sentences) || !Array.isArray(adjudication?.entries)) {
  throw new Error('Corpus, sentence source, or adjudication manifest is invalid');
}

const entries = structuredClone(corpus.entries);
const recordsById = uniqueMap(entries, entry => entry.id, 'corpus record');
const sourceById = uniqueMap(source.sentences, sentence => sentence.id, 'source sentence');
const normalizedSentence = value => String(value || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2013\u2014]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();
const lexicalKey = (word, sense) => `${normalizedSentence(word)}\0${normalizedSentence(sense)}`;
const shouldArchive = audit => audit?.confidence !== 'low' &&
  ['narrow_specialized', 'british_only', 'rare_or_dated'].includes(audit?.status);
const usagePriority = new Map([
  'modern_american', 'current_general', 'narrow_specialized', 'british_only', 'rare_or_dated',
].map((status, index) => [status, index]));

const savedSentences = entries.filter(entry => entry.type === 'sentence');
const savedTextSet = new Set(savedSentences.map(entry => normalizedSentence(entry.data?.text)).filter(Boolean));
const savedLexicalKeys = new Set(savedSentences
  .map(entry => lexicalKey(entry.data?.sourceWord, entry.data?.sourceSense))
  .filter(Boolean));
let cardsChanged = 0;
let examplesRewritten = 0;
let examplesRemoved = 0;
let lexicalCorrections = 0;
let protectedExampleDecisionsSkipped = 0;
let protectedLexicalCorrectionsSkipped = 0;
let savedLinksUpdated = 0;
let phraseRecordsReordered = 0;

for (const group of adjudication.entries) {
  const record = recordsById.get(group.parentId);
  if (!record || !['vocab', 'phrase'].includes(record.type) || record.type !== group.parentType) {
    throw new Error(`Unknown parent record: ${group.parentId}`);
  }
  const card = findCard(record, group.cardId, group.cardIndex);
  if (card.word !== group.word || card.sense !== group.sense) {
    throw new Error(`Card identity changed before adjudication: ${group.parentId}/${group.cardId}`);
  }
  const decision = group.decision;
  const oldWord = card.word;
  const oldSense = card.sense;
  const protectedMeaning = savedLexicalKeys.has(lexicalKey(oldWord, oldSense)) ||
    (card.examples || []).some(example => savedTextSet.has(normalizedSentence(example)));
  const exampleUpdates = [];
  for (let index = 0; index < group.examples.length; index++) {
    const sourceRecord = sourceById.get(group.examples[index].id);
    const exampleDecision = decision.examples[index];
    if (!sourceRecord || sourceRecord.text !== group.examples[index].text || exampleDecision.exampleIndex !== index) {
      throw new Error(`Sentence identity changed before adjudication: ${group.examples[index].id}`);
    }
    const matches = (card.examples || []).map((example, exampleIndex) => example === sourceRecord.text ? exampleIndex : -1)
      .filter(exampleIndex => exampleIndex >= 0);
    if (matches.length !== 1) throw new Error(`${group.examples[index].id}: expected one exact card example, found ${matches.length}`);
    exampleUpdates.push({ index: matches[0], decision: exampleDecision });
  }
  if (protectedMeaning) {
    protectedExampleDecisionsSkipped += exampleUpdates.filter(update => update.decision.action !== 'keep').length;
  } else {
    for (const update of exampleUpdates.sort((left, right) => right.index - left.index)) {
      if (update.decision.action === 'rewrite') {
        card.examples[update.index] = update.decision.replacement.trim();
        examplesRewritten++;
      } else if (update.decision.action === 'remove') {
        card.examples.splice(update.index, 1);
        examplesRemoved++;
      }
    }
  }
  if (!Array.isArray(card.examples) || card.examples.length < 2) {
    throw new Error(`${group.parentId}/${group.cardId}: adjudication left fewer than two examples`);
  }
  const exampleKeys = card.examples.map(normalizedSentence);
  if (new Set(exampleKeys).size !== exampleKeys.length) {
    throw new Error(`${group.parentId}/${group.cardId}: adjudication created duplicate examples`);
  }

  if (decision.lexicalAction === 'correct' && protectedMeaning) {
    protectedLexicalCorrectionsSkipped++;
  } else if (decision.lexicalAction === 'correct') {
    card.word = decision.correctedWord.trim();
    card.sense = decision.correctedSense.trim();
    if (decision.correctedForms.length > 0) {
      const wordKey = normalizedSentence(card.word);
      card.forms = [...new Set(decision.correctedForms.map(value => value.trim()))]
        .filter(value => normalizedSentence(value) !== wordKey);
    }
    lexicalCorrections++;
  }
  card.usageAudit = {
    status: decision.usageStatus,
    reason: decision.usageReason.trim(),
    confidence: decision.confidence,
    auditedAt: Number(group.adjudicatedAt || adjudication.generatedAt),
  };
  if (record.type === 'vocab') record.archiveForUsage = shouldArchive(card.usageAudit);

  if (card.word !== oldWord || card.sense !== oldSense) {
    const oldKey = lexicalKey(oldWord, oldSense);
    for (const saved of savedSentences) {
      if (lexicalKey(saved.data?.sourceWord, saved.data?.sourceSense) !== oldKey) continue;
      saved.data.sourceWord = card.word;
      saved.data.sourceSense = card.sense;
      savedLinksUpdated++;
    }
  }
  cardsChanged++;
}

for (const record of entries) {
  if (record.type !== 'phrase' || !Array.isArray(record.data?.vocabs)) continue;
  const before = record.data.vocabs.map(card => card.id).join('\0');
  record.data.vocabs.sort((left, right) =>
    (usagePriority.get(left.usageAudit?.status) ?? 99) -
    (usagePriority.get(right.usageAudit?.status) ?? 99));
  if (record.data.vocabs.map(card => card.id).join('\0') !== before) phraseRecordsReordered++;
}

const output = {
  ...corpus,
  generatedAt: Date.now(),
  model: `${adjudication.model} (regenerated corpus with targeted sentence-usage adjudication)`,
  entries,
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  cardsChanged,
  lexicalCorrections,
  examplesRewritten,
  examplesRemoved,
  protectedExampleDecisionsSkipped,
  protectedLexicalCorrectionsSkipped,
  savedLinksUpdated,
  phraseRecordsReordered,
  outputRecords: entries.length,
}, null, 2)}\n`);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function uniqueMap(values, keyFor, label) {
  const map = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!key || map.has(key)) throw new Error(`Invalid or duplicate ${label}: ${key || '<empty>'}`);
    map.set(key, value);
  }
  return map;
}

function findCard(record, cardId, cardIndex) {
  if (record.type === 'vocab') {
    if (record.data?.id !== cardId && record.id !== cardId) throw new Error(`Vocab card id mismatch: ${record.id}/${cardId}`);
    return record.data;
  }
  const matches = (record.data?.vocabs || []).filter(card => card.id === cardId);
  if (matches.length === 1) return matches[0];
  const indexed = record.data?.vocabs?.[cardIndex];
  if (matches.length === 0 && indexed?.id === cardId) return indexed;
  throw new Error(`Phrase card id mismatch: ${record.id}/${cardId}`);
}
