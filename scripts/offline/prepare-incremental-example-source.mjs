#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readJson, writePrivateJson } from './offline-io.mjs';

const [currentArg, baselineArg, outputArg, previousArg] = process.argv.slice(2);
if (!currentArg || !baselineArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-example-source.mjs <current-source.json> <baseline-source.json> <output.json> [previous-incremental-source.json]',
  );
}

const readSource = (path, label, allowEmpty = false) => {
  const source = readJson(path);
  if (source?.version !== 1 || !Array.isArray(source.sentences) || (!allowEmpty && source.sentences.length === 0)) {
    throw new Error(`${label} is invalid`);
  }
  const byId = new Map();
  for (const sentence of source.sentences) {
    if (typeof sentence?.id !== 'string' || !sentence.id || typeof sentence.textHash !== 'string' ||
        byId.has(sentence.id)) {
      throw new Error(`${label} contains an invalid or duplicate sentence id`);
    }
    byId.set(sentence.id, sentence);
  }
  return { source, byId };
};

const current = readSource(currentArg, 'Current sentence source');
const baseline = readSource(baselineArg, 'Baseline sentence source');
const previous = previousArg
  ? readSource(previousArg, 'Previous incremental sentence source', true)
  : { source: null, byId: new Map() };

// The pool carries production's coverage of every example (build-example-sentence-pool.mjs takes it from the corpus
// export), so the live corpus decides which sentences still need an analysis or an image.
if (current.source.stats?.exampleEnrichmentCoverageAvailable !== true) {
  throw new Error('Current sentence source has no production coverage; build it from a current corpus export');
}

// A sentence keeps the text and hash it was first seen with, with its coverage refreshed: the lookup identity ignores
// learning markup, so a markup-only edit needs no regeneration. A sentence no longer in the corpus drops out, and if
// it returns, its coverage decides again. The baseline only tells a coverage repair from a new discovery.
const incremental = new Map();
let newlyDiscovered = 0;
let coverageRepairs = 0;
for (const [id, sentence] of current.byId) {
  if (sentence.hasAnalysis === true && sentence.hasImage === true) continue;
  const prior = previous.byId.get(id);
  if (prior) {
    incremental.set(id, {
      ...prior,
      hasAnalysis: sentence.hasAnalysis === true,
      hasImage: sentence.hasImage === true,
    });
    continue;
  }
  if (baseline.byId.has(id)) coverageRepairs++;
  else newlyDiscovered++;
  incremental.set(id, sentence);
}

const sentences = [...incremental.values()].sort((left, right) => left.id.localeCompare(right.id));
const output = {
  version: 1,
  exportedAt: Date.now(),
  sourceGeneratedAt: Number(current.source.sourceGeneratedAt || current.source.exportedAt || 0),
  sentences,
  stats: {
    corpusRecords: Number(current.source.stats?.corpusRecords || 0),
    savedSentenceTexts: Number(current.source.stats?.savedSentenceTexts || 0),
    baselineSentences: baseline.byId.size,
    currentSentences: current.byId.size,
    newlyDiscovered,
    coverageRepairs,
    retired: [...previous.byId.keys()].filter(id => !current.byId.has(id)).length,
  },
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writePrivateJson(outputPath, output);
process.stdout.write(`${JSON.stringify({
  baselineSentences: baseline.byId.size,
  currentSentences: current.byId.size,
  previousIncremental: previous.byId.size,
  newlyDiscovered,
  coverageRepairs,
  retired: output.stats.retired,
  incrementalSentences: sentences.length,
}, null, 2)}\n`);
