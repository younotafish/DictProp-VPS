#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [sourceArg, baseAnalysisArg, outputDirArg, supplementalAnalysisArg] = process.argv.slice(2);
if (!sourceArg || !baseAnalysisArg || !outputDirArg) {
  throw new Error(
    'Usage: reconcile-sentence-analyses.mjs <final-source.json> <base-analysis.json> <output-directory> [supplemental-analysis.json]',
  );
}

const source = readJson(sourceArg);
const baseAnalysis = readJson(baseAnalysisArg);
const supplementalAnalysis = supplementalAnalysisArg ? readJson(supplementalAnalysisArg) : null;
const outputDir = resolve(outputDirArg);

if (source?.version !== 1 || !Array.isArray(source.sentences) || source.sentences.length === 0) {
  throw new Error('Final sentence source is invalid or empty');
}

const finalById = indexFinalSource(source.sentences);
const baseById = indexAnalyses(baseAnalysis, 'base analysis');
const supplementalById = supplementalAnalysis
  ? indexAnalyses(supplementalAnalysis, 'supplemental analysis')
  : new Map();

const reusedEntries = [];
const supplementalEntries = [];
const missingSentences = [];
const staleBaseEntries = [];
const staleSupplementalEntries = [];

for (const entry of baseById.values()) {
  const sentence = finalById.get(entry.id);
  if (!sentence || sentence.textHash !== entry.textHash) staleBaseEntries.push(entry);
}
for (const entry of supplementalById.values()) {
  const sentence = finalById.get(entry.id);
  if (!sentence || sentence.textHash !== entry.textHash) staleSupplementalEntries.push(entry);
}

for (const sentence of source.sentences) {
  const baseEntry = matchingEntry(baseById, sentence);
  if (baseEntry) {
    reusedEntries.push(baseEntry);
    continue;
  }
  const supplementalEntry = matchingEntry(supplementalById, sentence);
  if (supplementalEntry) {
    supplementalEntries.push(supplementalEntry);
    continue;
  }
  missingSentences.push(sentence);
}

const generatedAt = Math.max(
  Number(baseAnalysis.generatedAt || 0),
  Number(supplementalAnalysis?.generatedAt || 0),
  Date.now(),
);
const completeEntries = [...reusedEntries, ...supplementalEntries]
  .sort((left, right) => left.id.localeCompare(right.id));
const report = {
  sourceSentences: source.sentences.length,
  reused: reusedEntries.length,
  supplemented: supplementalEntries.length,
  missing: missingSentences.length,
  staleBase: staleBaseEntries.length,
  staleSupplemental: staleSupplementalEntries.length,
  complete: missingSentences.length === 0 && completeEntries.length === source.sentences.length,
};

mkdirSync(outputDir, { recursive: true });
writePrivateJson(resolve(outputDir, 'missing-source.json'), {
  version: 1,
  exportedAt: Date.now(),
  sourceGeneratedAt: Number(source.sourceGeneratedAt || source.exportedAt || 0),
  sentences: missingSentences,
  stats: {
    corpusRecords: Number(source.stats?.corpusRecords || 0),
    savedSentenceTexts: Number(source.stats?.savedSentenceTexts || 0),
    exampleSlots: missingSentences.length,
    savedSlots: 0,
    duplicateSlots: 0,
    poolSentences: missingSentences.length,
  },
});
writePrivateJson(resolve(outputDir, 'reused-analysis.json'), {
  version: 1,
  generatedAt,
  entries: reusedEntries.sort((left, right) => left.id.localeCompare(right.id)),
});
writePrivateJson(resolve(outputDir, 'stale-analysis.json'), {
  version: 1,
  generatedAt,
  entries: [...staleBaseEntries, ...staleSupplementalEntries]
    .sort((left, right) => left.id.localeCompare(right.id)),
});
writePrivateJson(resolve(outputDir, 'report.json'), report);

if (report.complete) {
  writePrivateJson(resolve(outputDir, 'final-analysis.json'), {
    version: 1,
    generatedAt,
    entries: completeEntries,
  });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (supplementalAnalysis && !report.complete) process.exitCode = 1;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function indexFinalSource(sentences) {
  const byId = new Map();
  for (const sentence of sentences) {
    if (!sentence || typeof sentence.id !== 'string' || typeof sentence.textHash !== 'string') {
      throw new Error('Final sentence source contains an invalid identity');
    }
    if (byId.has(sentence.id)) throw new Error(`Duplicate final sentence id: ${sentence.id}`);
    byId.set(sentence.id, sentence);
  }
  return byId;
}

function indexAnalyses(manifest, label) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`${label} manifest is invalid`);
  }
  const byId = new Map();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.textHash !== 'string' || !entry.analysis) {
      throw new Error(`${label} contains an invalid entry`);
    }
    if (byId.has(entry.id)) throw new Error(`${label} contains duplicate id: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  return byId;
}

function matchingEntry(entries, sentence) {
  const entry = entries.get(sentence.id);
  return entry?.textHash === sentence.textHash ? entry : null;
}
