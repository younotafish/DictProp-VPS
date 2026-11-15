import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { completeAnalysis } from './support/fixtures.js';
import { sha256 } from './support/fs.js';
import { runScript } from './support/library.js';

const { pronunciation: _pronunciation, ...incompleteAnalysis } = completeAnalysis;

test('the saved-sentence source lists what still needs analysis, and its base file carries the partial analyses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dictprop-saved-source-'));
  const corpus = {
    version: 1,
    exportedAt: 500,
    items: [
      { type: 'sentence', data: { id: 's-complete', text: 'It worked.', sourceWord: 'work', analysis: completeAnalysis } },
      {
        type: 'sentence',
        data: { id: 's-partial', text: 'It nearly worked.', sourceWord: 'work', sourceSense: 'verb: function', analysis: incompleteAnalysis, analysisGeneratedAt: 40 },
      },
      { type: 'sentence', data: { id: 's-undated', text: 'It worked once.', sourceWord: 'work', analysis: incompleteAnalysis } },
      { type: 'sentence', data: { id: 's-bare', text: 'Nothing yet.', sourceWord: 'yet' } },
      { type: 'sentence', wasArchived: true, data: { id: 's-archived', text: 'Archived.', sourceWord: 'archive' } },
      { type: 'vocab', data: { id: 'v-word', word: 'work' } },
    ],
  };
  const corpusPath = join(dir, 'corpus.json');
  writeFileSync(corpusPath, JSON.stringify(corpus));
  const sourcePath = join(dir, 'out', 'source.json');
  const basePath = join(dir, 'out', 'base-analysis.json');

  const run = runScript('prepare-incremental-saved-sentence-source', [corpusPath, sourcePath, '-', basePath]);
  assert.equal(run.status, 0, run.stderr);
  const stats = {
    corpusRecords: 6, savedSentences: 4, incompleteSentences: 3, newlyDiscovered: 3, changedSentences: 0,
  };
  assert.deepEqual(JSON.parse(run.stdout), stats);

  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  assert.equal(source.version, 1);
  assert.equal(source.sourceGeneratedAt, 500);
  assert.deepEqual(source.stats, stats);
  assert.deepEqual(source.sentences, [
    { id: 's-bare', text: 'Nothing yet.', sourceWord: 'yet', textHash: sha256('Nothing yet.') },
    { id: 's-partial', text: 'It nearly worked.', sourceWord: 'work', sourceSense: 'verb: function', textHash: sha256('It nearly worked.') },
    { id: 's-undated', text: 'It worked once.', sourceWord: 'work', textHash: sha256('It worked once.') },
  ]);

  // Only the incomplete sentences that have an analysis to build on, dated by it or else by the export.
  assert.deepEqual(JSON.parse(readFileSync(basePath, 'utf8')), {
    version: 1,
    generatedAt: 500,
    entries: [
      { id: 's-partial', textHash: sha256('It nearly worked.'), analysis: incompleteAnalysis, generatedAt: 40 },
      { id: 's-undated', textHash: sha256('It worked once.'), analysis: incompleteAnalysis, generatedAt: 500 },
    ],
  });
  for (const path of [sourcePath, basePath]) assert.equal(statSync(path).mode & 0o777, 0o600);

  // A missing previous source counts every sentence as newly discovered, like '-'.
  const again = runScript('prepare-incremental-saved-sentence-source', [corpusPath, sourcePath, join(dir, 'none.json')]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), stats);
});
