#!/usr/bin/env node

import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson, writePrivateJson } from './offline-io.mjs';
import { isDetailedSentenceAnalysis, isSentenceAnalysis } from './sentence-analysis-contract.mjs';

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
const allowProductionCoveredBasic = process.env.ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS === '1';

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
const unusableBase = countUnusable(baseById);
const unusableSupplemental = countUnusable(supplementalById);
// Every sentence is reused, supplemented or missing, so nothing missing means every sentence has an analysis.
const report = {
  sourceSentences: source.sentences.length,
  reused: reusedEntries.length,
  supplemented: supplementalEntries.length,
  missing: missingSentences.length,
  staleBase: unusableBase.stale,
  staleSupplemental: unusableSupplemental.stale,
  incompleteBase: unusableBase.incomplete,
  incompleteSupplemental: unusableSupplemental.incomplete,
  complete: missingSentences.length === 0,
};

mkdirSync(outputDir, { recursive: true });
// Earlier versions wrote these lists here, unread; in the example cycle the stale list held nearly the whole baseline.
for (const name of ['reused-analysis.json', 'stale-analysis.json', 'incomplete-analysis.json']) {
  rmSync(resolve(outputDir, name), { force: true });
}
// The analysis stage reads only the sentences.
writePrivateJson(resolve(outputDir, 'missing-source.json'), {
  version: 1,
  exportedAt: Date.now(),
  sentences: missingSentences,
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

/** Counts a manifest's entries that no source sentence can use: stale (no sentence with that id and text) or incomplete. */
function countUnusable(byId) {
  let stale = 0;
  let incomplete = 0;
  for (const entry of byId.values()) {
    const sentence = finalById.get(entry.id);
    if (!sentence || sentence.textHash !== entry.textHash) stale++;
    else if (!acceptableAnalysis(entry.analysis, sentence)) incomplete++;
  }
  return { stale, incomplete };
}

function matchingEntry(entries, sentence) {
  const entry = entries.get(sentence.id);
  return entry?.textHash === sentence.textHash && acceptableAnalysis(entry.analysis, sentence) ? entry : null;
}

function acceptableAnalysis(analysis, sentence) {
  return isDetailedSentenceAnalysis(analysis) ||
    (allowProductionCoveredBasic && sentence?.hasAnalysis === true && isSentenceAnalysis(analysis));
}
