#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  isDetailedSentenceAnalysis,
  isSentenceGrammarAnalysis,
  normalizeDetailedSentenceAnalysis,
} from './sentence-analysis-contract.mjs';

const [detailedArg, grammarArg, outputArg] = process.argv.slice(2);
if (!detailedArg || !grammarArg || !outputArg) {
  throw new Error(
    'Usage: merge-sentence-grammar-manifests.mjs <detailed-analysis.json> <grammar-analysis.json> <output.json>',
  );
}

const readManifest = (path, label) => {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error(`${label} manifest is invalid or empty`);
  }
  return value;
};

const detailed = readManifest(detailedArg, 'Detailed analysis');
const grammar = readManifest(grammarArg, 'Grammar analysis');
const grammarById = new Map();
for (const entry of grammar.entries) {
  if (typeof entry?.id !== 'string' || !entry.id || grammarById.has(entry.id) ||
      typeof entry.textHash !== 'string') {
    throw new Error('Grammar analysis contains an invalid or duplicate identity');
  }
  grammarById.set(entry.id, entry);
}

const seen = new Set();
const entries = detailed.entries.map(entry => {
  if (typeof entry?.id !== 'string' || !entry.id || seen.has(entry.id) ||
      typeof entry.textHash !== 'string' || !isDetailedSentenceAnalysis(entry.analysis)) {
    throw new Error(`Detailed analysis contains an invalid entry: ${String(entry?.id)}`);
  }
  seen.add(entry.id);
  const grammarEntry = grammarById.get(entry.id);
  if (!grammarEntry || grammarEntry.textHash !== entry.textHash) {
    throw new Error(`Grammar identity mismatch: ${entry.id}`);
  }
  const replacementGrammar = grammarEntry.analysis?.grammar ?? grammarEntry.grammar;
  if (!isSentenceGrammarAnalysis(replacementGrammar)) {
    throw new Error(`Grammar analysis is incomplete: ${entry.id}`);
  }
  return {
    ...entry,
    analysis: normalizeDetailedSentenceAnalysis(entry.analysis, replacementGrammar, entry.id),
    generatedAt: Math.max(Number(entry.generatedAt || 0), Number(grammarEntry.generatedAt || 0)),
  };
});

if (seen.size !== grammarById.size) {
  const extras = [...grammarById.keys()].filter(id => !seen.has(id));
  throw new Error(`Grammar coverage mismatch; unexpected ids: ${extras.slice(0, 5).join(', ')}`);
}

const outputPath = resolve(outputArg);
const temporaryPath = `${outputPath}.tmp-${process.pid}`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(temporaryPath, `${JSON.stringify({
  ...detailed,
  generatedAt: Math.max(Number(detailed.generatedAt || 0), Number(grammar.generatedAt || 0)),
  entries,
}, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryPath, outputPath);
process.stderr.write(`Merged ${entries.length} detailed analyses with preserved grammar\n`);
