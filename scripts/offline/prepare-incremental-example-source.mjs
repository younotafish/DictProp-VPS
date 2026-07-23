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

// Keep the incremental source monotonic. This makes publication resumable even if an old example is
// later edited or removed. The lookup identity ignores learning markup, so the first verified version
// remains valid for later markup-only changes and does not need to be republished under the same id.
const incremental = new Map(previous.byId);
let newlyDiscovered = 0;
for (const [id, sentence] of current.byId) {
  if (baseline.byId.has(id)) continue;
  if (incremental.has(id)) continue;
  newlyDiscovered++;
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
  incrementalSentences: sentences.length,
}, null, 2)}\n`);
