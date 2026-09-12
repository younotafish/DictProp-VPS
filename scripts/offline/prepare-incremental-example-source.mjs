#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [currentArg, baselineArg, outputArg, previousArg] = process.argv.slice(2);
if (!currentArg || !baselineArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-example-source.mjs <current-source.json> <baseline-source.json> <output.json> [previous-incremental-source.json]',
  );
}

const readSource = (path, label, allowEmpty = false) => {
  const source = JSON.parse(readFileSync(resolve(path), 'utf8'));
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

// Legacy exports without coverage stay monotonic for compatibility. Once the export reports live
// coverage, retain the first text/hash identity only for sentences that remain in the current corpus.
// The lookup identity ignores learning markup, so markup-only changes do not require regeneration.
const coverageAvailable = current.source.stats?.exampleEnrichmentCoverageAvailable === true;
// Once production coverage is available, the live corpus is authoritative. Historical entries that
// are no longer referenced do not need repeated repair attempts; if they return later, their server
// coverage will decide whether they are re-added.
const incremental = coverageAvailable ? new Map() : new Map(previous.byId);
let newlyDiscovered = 0;
let coverageRepairs = 0;
for (const [id, sentence] of current.byId) {
  const prior = previous.byId.get(id);
  const needsCoverageRepair = coverageAvailable &&
    (sentence.hasAnalysis !== true || sentence.hasImage !== true);
  if (coverageAvailable && !needsCoverageRepair) continue;
  if (prior) {
    // Preserve the first published text/hash identity, while refreshing server coverage flags used
    // to decide which analysis and image waves still need publication.
    incremental.set(id, {
      ...prior,
      ...(coverageAvailable ? {
        hasAnalysis: sentence.hasAnalysis === true,
        hasImage: sentence.hasImage === true,
      } : {}),
    });
    continue;
  }
  if (baseline.byId.has(id) && !needsCoverageRepair) continue;
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
    exampleSlots: sentences.length,
    savedSlots: 0,
    duplicateSlots: 0,
    poolSentences: sentences.length,
    baselineSentences: baseline.byId.size,
    currentSentences: current.byId.size,
    newlyDiscovered,
    coverageRepairs,
    retired: coverageAvailable
      ? [...previous.byId.keys()].filter(id => !current.byId.has(id)).length
      : 0,
  },
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  baselineSentences: baseline.byId.size,
  currentSentences: current.byId.size,
  previousIncremental: previous.byId.size,
  newlyDiscovered,
  coverageRepairs,
  retired: output.stats.retired,
  incrementalSentences: sentences.length,
}, null, 2)}\n`);
