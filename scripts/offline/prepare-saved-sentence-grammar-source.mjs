#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [corpusArg, outputArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error('Usage: prepare-saved-sentence-grammar-source.mjs <corpus-export.json> <output-directory>');
}

const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
if (corpus?.version !== 1 || !Array.isArray(corpus.items)) throw new Error('Corpus export is invalid');

const sentences = [];
const analysisEntries = [];
const missingSentences = [];
for (const item of corpus.items) {
  if (item?.type !== 'sentence' || item.isDeleted) continue;
  const data = item.data || {};
  if (typeof data.id !== 'string' || !data.id || typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error('Corpus contains an invalid saved sentence');
  }
  const textHash = createHash('sha256').update(data.text).digest('hex');
  const source = {
    id: data.id,
    text: data.text,
    sourceWord: typeof data.sourceWord === 'string' ? data.sourceWord : '',
    ...(typeof data.sourceSense === 'string' ? { sourceSense: data.sourceSense } : {}),
    textHash,
    hasAnalysis: !!data.analysis,
    hasGrammar: !!data.analysis?.grammar,
    hasImage: typeof data.imageUrl === 'string' && data.imageUrl.length > 0,
  };
  sentences.push(source);
  if (data.analysis && typeof data.analysis === 'object' && !Array.isArray(data.analysis)) {
    analysisEntries.push({
      id: data.id,
      textHash,
      analysis: data.analysis,
      generatedAt: Number(data.analysisGeneratedAt || corpus.exportedAt || Date.now()),
    });
  } else {
    missingSentences.push(source);
  }
}
if (sentences.length === 0) throw new Error('Corpus export contains no saved sentences');

sentences.sort((left, right) => left.id.localeCompare(right.id));
analysisEntries.sort((left, right) => left.id.localeCompare(right.id));
missingSentences.sort((left, right) => left.id.localeCompare(right.id));
const outputDir = resolve(outputArg);
mkdirSync(outputDir, { recursive: true });
const writeJson = (name, value) => writeFileSync(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
writeJson('source.json', { version: 1, exportedAt: Number(corpus.exportedAt || Date.now()), sentences });
writeJson('base-analysis.json', { version: 1, generatedAt: Number(corpus.exportedAt || Date.now()), entries: analysisEntries });
writeJson('missing-source.json', {
  version: 1,
  exportedAt: Number(corpus.exportedAt || Date.now()),
  sentences: missingSentences,
});
process.stdout.write(`${JSON.stringify({
  savedSentences: sentences.length,
  existingAnalyses: analysisEntries.length,
  existingGrammar: analysisEntries.filter(entry => entry.analysis?.grammar).length,
  missingAnalyses: missingSentences.length,
}, null, 2)}\n`);
