#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [corpusArg, outputArg, overlayArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error(
    'Usage: build-example-sentence-pool.mjs <corpus-export-or-manifest.json> <output.json> [local-vocab-overlay.json|-]',
  );
}

const source = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
const sourceRecords = Array.isArray(source?.items) ? source.items : source?.entries;
if (!Array.isArray(sourceRecords) || sourceRecords.length === 0) throw new Error('Corpus input has no records');
const overlayById = new Map();
if (overlayArg && overlayArg !== '-') {
  const overlay = JSON.parse(readFileSync(resolve(overlayArg), 'utf8'));
  if (overlay?.version !== 1 || !Array.isArray(overlay.entries)) {
    throw new Error('Local vocabulary overlay is invalid');
  }
  for (const entry of overlay.entries) overlayById.set(entry.id, entry);
}
const records = sourceRecords.map(record => {
  const overlay = overlayById.get(record.id);
  return overlay
    ? { ...record, data: overlay.data, archiveForUsage: overlay.archiveForUsage }
    : record;
});
const enrichmentCoverage = new Map(
  (Array.isArray(source?.exampleEnrichmentCoverage) ? source.exampleEnrichmentCoverage : [])
    .filter(entry => typeof entry?.lookupHash === 'string')
    .map(entry => [entry.lookupHash, entry]),
);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const plainSentence = value => String(value || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1');
const normalizedSentence = value => plainSentence(value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2013\u2014]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

const savedTexts = new Set(records
  .filter(record => record.type === 'sentence' && typeof record.data?.text === 'string')
  .map(record => normalizedSentence(record.data.text))
  .filter(Boolean));

const pooled = new Map();
let exampleSlots = 0;
let savedSlots = 0;
let duplicateSlots = 0;

function addCard(record, card, cardIndex) {
  for (const example of Array.isArray(card?.examples) ? card.examples : []) {
    if (typeof example !== 'string' || !example.trim()) continue;
    exampleSlots++;
    const text = example.trim();
    const normalized = normalizedSentence(text);
    if (!normalized) continue;
    if (savedTexts.has(normalized)) {
      savedSlots++;
      continue;
    }
    const lookupHash = sha256(normalized);
    const prepared = enrichmentCoverage.get(lookupHash);
    const provenance = {
      parentId: record.id,
      parentType: record.type,
      cardId: card.id,
      cardIndex,
      word: card.word || '',
      sense: card.sense || '',
      usageStatus: card.usageAudit?.status || record.data?.usageAudit?.status || 'unknown',
      archived: record.archiveForUsage === true || record.wasArchived === true,
    };
    const existing = pooled.get(lookupHash);
    if (existing) {
      duplicateSlots++;
      if (!existing.provenance.some(entry => entry.parentId === provenance.parentId && entry.cardId === provenance.cardId)) {
        existing.provenance.push(provenance);
      }
      continue;
    }
    pooled.set(lookupHash, {
      id: `example-${lookupHash.slice(0, 40)}`,
      text,
      sourceWord: card.word || '',
      sourceSense: card.sense || '',
      textHash: sha256(text),
      lookupHash,
      hasAnalysis: prepared?.hasAnalysis === true,
      hasImage: prepared?.hasImage === true,
      provenance: [provenance],
    });
  }
}

for (const record of records) {
  if (record.type === 'vocab') addCard(record, record.data, 0);
  if (record.type === 'phrase') {
    for (let index = 0; index < (record.data?.vocabs || []).length; index++) {
      addCard(record, record.data.vocabs[index], index);
    }
  }
}

const sentences = [...pooled.values()].sort((left, right) => left.lookupHash.localeCompare(right.lookupHash));
const output = {
  version: 1,
  exportedAt: Date.now(),
  sourceGeneratedAt: Number(source.generatedAt || source.exportedAt || 0),
  sentences,
  stats: {
    corpusRecords: records.length,
    exampleEnrichmentCoverageAvailable: Array.isArray(source?.exampleEnrichmentCoverage),
    exampleEnrichmentCoverageRows: enrichmentCoverage.size,
    savedSentenceTexts: savedTexts.size,
    exampleSlots,
    savedSlots,
    duplicateSlots,
    poolSentences: sentences.length,
  },
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(output.stats, null, 2)}\n`);
