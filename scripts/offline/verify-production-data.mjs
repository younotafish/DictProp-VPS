#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [corpusArg, analysisArg, productionArg, sentenceExportArg, allowedMissingArg] = process.argv.slice(2);
if (!corpusArg || !analysisArg || !productionArg) {
  throw new Error('Usage: verify-production-data.mjs <corpus-manifest> <analysis-manifest> <production-corpus-export> [sentence-export] [allowed-missing.json]');
}

const readJson = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const corpus = readJson(corpusArg);
const analyses = readJson(analysisArg);
const production = readJson(productionArg);
const sentenceExport = sentenceExportArg ? readJson(sentenceExportArg) : null;
const allowedMissing = new Set(allowedMissingArg ? readJson(allowedMissingArg) : []);

const canonicalize = (value, options = {}) => {
  if (Array.isArray(value)) return value.map(child => canonicalize(child, options));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
    if (key === 'imageUrl') return [];
    if (options.omitSentenceAnalysis && (key === 'analysis' || key === 'analysisGeneratedAt')) return [];
    return [[key, canonicalize(value[key], options)]];
  }));
};
const hash = (value, options) => createHash('sha256')
  .update(JSON.stringify(canonicalize(value, options)))
  .digest('hex');
const sample = values => values.slice(0, 200);

const productionById = new Map(production.items.map(item => [item.id, item]));
const corpusById = new Map(corpus.entries.map(entry => [entry.id, entry]));
const missing = [];
const unexpectedMissing = [];
const contentMismatches = [];
const archiveMismatches = [];

for (const entry of corpus.entries) {
  const actual = productionById.get(entry.id);
  if (!actual) {
    missing.push(entry.id);
    if (!allowedMissing.has(entry.id)) unexpectedMissing.push(entry.id);
    continue;
  }
  const omitSentenceAnalysis = entry.type === 'sentence';
  if (hash(actual.data, { omitSentenceAnalysis }) !== hash(entry.data, { omitSentenceAnalysis })) {
    contentMismatches.push(entry.id);
  }
  if ((entry.wasArchived || entry.archiveForUsage) && !actual.wasArchived) archiveMismatches.push(entry.id);
}

const extras = production.items.filter(item => !corpusById.has(item.id)).map(item => item.id);
const analysisById = new Map(analyses.entries.map(entry => [entry.id, entry]));
const missingAnalyses = [];
const analysisMismatches = [];
const sentenceTextMismatches = [];
const timestampMismatches = [];
for (const entry of analyses.entries) {
  const item = productionById.get(entry.id);
  if (!item) {
    if (!allowedMissing.has(entry.id)) missingAnalyses.push(entry.id);
    continue;
  }
  if (hash(item.data.analysis) !== hash(entry.analysis)) analysisMismatches.push(entry.id);
  const textHash = createHash('sha256').update(String(item.data.text || '')).digest('hex');
  if (textHash !== entry.textHash) sentenceTextMismatches.push(entry.id);
  if (!(Number.isFinite(item.data.analysisGeneratedAt) && item.data.analysisGeneratedAt >= entry.generatedAt)) {
    timestampMismatches.push(entry.id);
  }
}

const sentenceImageMissing = [];
const sentenceExportMissing = [];
if (sentenceExport) {
  const exportedById = new Map(sentenceExport.sentences.map(sentence => [sentence.id, sentence]));
  for (const id of analysisById.keys()) {
    if (allowedMissing.has(id)) continue;
    const sentence = exportedById.get(id);
    if (!sentence) sentenceExportMissing.push(id);
    else if (!sentence.hasImage) sentenceImageMissing.push(id);
  }
}

const report = {
  generatedAt: Date.now(),
  corpus: {
    targetCount: corpus.entries.length,
    productionCount: production.items.length,
    missingCount: missing.length,
    unexpectedMissingCount: unexpectedMissing.length,
    unexpectedMissingIds: sample(unexpectedMissing),
    contentMismatchCount: contentMismatches.length,
    contentMismatchIds: sample(contentMismatches),
    archiveMismatchCount: archiveMismatches.length,
    archiveMismatchIds: sample(archiveMismatches),
    extraProductionCount: extras.length,
    extraProductionIds: sample(extras),
  },
  sentenceAnalysis: {
    targetCount: analyses.entries.length,
    missingCount: missingAnalyses.length,
    missingIds: sample(missingAnalyses),
    contentMismatchCount: analysisMismatches.length,
    contentMismatchIds: sample(analysisMismatches),
    textMismatchCount: sentenceTextMismatches.length,
    textMismatchIds: sample(sentenceTextMismatches),
    timestampMismatchCount: timestampMismatches.length,
    timestampMismatchIds: sample(timestampMismatches),
  },
  sentenceImages: sentenceExport ? {
    missingRecordCount: sentenceExportMissing.length,
    missingRecordIds: sample(sentenceExportMissing),
    missingImageCount: sentenceImageMissing.length,
    missingImageIds: sample(sentenceImageMissing),
  } : null,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (unexpectedMissing.length || contentMismatches.length || archiveMismatches.length ||
    missingAnalyses.length || analysisMismatches.length || sentenceTextMismatches.length ||
    timestampMismatches.length || sentenceExportMissing.length || sentenceImageMissing.length) {
  process.exitCode = 1;
}
