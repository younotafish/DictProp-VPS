import assert from 'node:assert/strict';
import test from 'node:test';
import { completeAnalysis, completeVocab } from './support/fixtures.js';
import { png, sha256 } from './support/fs.js';
import {
  addItemImage, createOwner, lastJsonLine, runScript, saveItem, storeExample, storeRawExample,
} from './support/library.js';

const { advancedVocabContentHash, imagePromptHash } = await import('../src/incremental-enrichment.js');
const { exampleSentenceId, sentenceLookupHash } = await import('../src/sentence-lookup.js');

const HOUR = 60 * 60 * 1_000;
const owner = createOwner();
const { pronunciation: _pronunciation, ...incompleteAnalysis } = completeAnalysis;
const ids = (texts: string[]) => texts.map(sentenceLookupHash).sort((left, right) => left.localeCompare(right))
  .map(exampleSentenceId);
const noGaps = {
  sentenceDetailedAnalysis: 0,
  sentenceImage: 0,
  recentVocabContent: 0,
  recentVocabAdvanced: 0,
  recentNestedVocabContent: 0,
  recentNestedVocabAdvanced: 0,
  recentVocabLocalImage: 0,
  recentPhraseLocalImage: 0,
  recentNestedVocabLocalImage: 0,
  vocabImage: 0,
  phraseImage: 0,
  nestedVocabImage: 0,
};

// A card the local cycle finished a month ago: its markers are current, its image and both examples are stored.
const done = { ...completeVocab, id: 'ae-done' };
saveItem(owner.id, 'ae-done', 'vocab', {
  ...done,
  advancedEnrichment: {
    version: 1, provider: 'claude-code', model: 'claude-opus-5-5', generatedAt: 1, contentHash: advancedVocabContentHash(done),
  },
  localImageEnrichment: {
    version: 1, provider: 'local-ernie', model: 'local-test-image-model', generatedAt: 1, promptHash: imagePromptHash(done.imagePrompt),
  },
}, { savedAt: Date.now() - 30 * 24 * HOUR });
addItemImage(owner.id, 'ae-done');
for (const example of completeVocab.examples) storeExample(example, completeAnalysis, png(example));

test('the enrichment audit reports a finished library as complete and exits 0', () => {
  const before = Date.now();
  const run = runScript('audit-enrichment');
  const after = Date.now();
  assert.equal(run.status, 0, run.stderr);
  // One line: the workflow's alert step reads the stall from the last JSON line of the output.
  assert.equal(run.stdout.trim().split('\n').length, 1);

  const report = lastJsonLine(run.stdout);
  assert.deepEqual(Object.keys(report), [
    'mode', 'prioritySince', 'complete', 'stall', 'topLevel', 'exampleGaps', 'exampleSentenceCoverage',
  ]);
  assert.equal(report.mode, 'audit-only');
  assert.ok(report.prioritySince >= before - 24 * HOUR && report.prioritySince <= after - 24 * HOUR);
  assert.equal(report.complete, true);
  assert.deepEqual(report.stall.alerts, []);
  assert.equal(report.stall.textGaps, 0);
  assert.equal(report.stall.imageGaps, 0);
  assert.deepEqual(report.topLevel, {
    items: 0, recentItems: 0, historicalItems: 0, byType: { sentence: 0, vocab: 0, phrase: 0 }, gaps: noGaps,
  });
  assert.equal(report.exampleGaps, 0);
  assert.equal(report.exampleSentenceCoverage.expected, 2);
  assert.equal(report.exampleSentenceCoverage.fullyEnriched, 2);
});

test('the enrichment audit counts each kind of stored example, and exits 1 once an analysis is overdue', () => {
  const now = Date.now();
  // Saved twenty hours ago and still bare: past the eighteen hours the cycle gets.
  saveItem(owner.id, 'ae-waiting', 'vocab', { word: 'waiting' }, { savedAt: now - 20 * HOUR });
  const examples = [
    'Nobody stored anything for this example.',
    'This example lacks its pronunciation guide.',
    'This example was stored as broken JSON.',
    'This example lost its image blob.',
  ];
  saveItem(owner.id, 'ae-examples', 'vocab', { word: 'examples', examples }, { savedAt: now - 30 * 24 * HOUR });
  storeExample(examples[1], incompleteAnalysis);
  storeRawExample(examples[2], '{"translation":', null);
  storeRawExample(examples[3], JSON.stringify(completeAnalysis), sha256('gone'));
  // No card uses this one any more, but it is still the newest thing the cycle published.
  const newest = now + 5_000;
  storeRawExample('An example no card uses any more.', JSON.stringify(completeAnalysis), null, newest);

  const run = runScript('audit-enrichment');
  assert.equal(run.status, 1, run.stderr);
  const report = lastJsonLine(run.stdout);
  assert.equal(report.complete, false);
  assert.deepEqual(report.topLevel, {
    items: 1,
    recentItems: 1,
    historicalItems: 0,
    byType: { sentence: 0, vocab: 1, phrase: 0 },
    gaps: { ...noGaps, recentVocabContent: 1, recentVocabAdvanced: 1 },
  });
  assert.equal(report.exampleGaps, 4);
  assert.deepEqual(report.exampleSentenceCoverage, {
    expected: 6,
    fullyEnriched: 2,
    completeDetailedAnalysis: 3,
    missingAnalysis: 1,
    incompleteDetailedAnalysis: 2,
    withImage: 2,
    missingImage: 4,
    missingAnalysisIds: ids([examples[0]]),
    incompleteDetailedAnalysisIds: ids([examples[1], examples[2]]),
    missingImageIds: ids(examples),
  });
  assert.equal(report.stall.textGaps, 5);
  assert.equal(report.stall.imageGaps, 4);
  assert.equal(report.stall.lastLocalEnrichmentAt, newest);
  assert.deepEqual(report.stall.alerts, [
    '5 analyses have been due for over 18 h, so the local enrichment cycle may have stopped (it last published 0 h ago)',
  ]);
});
