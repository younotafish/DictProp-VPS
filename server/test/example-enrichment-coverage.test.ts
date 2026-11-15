import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectExpectedExampleSentenceHashes,
  summarizeExampleEnrichmentCoverage,
} from '../src/example-enrichment-coverage.js';
import { sentenceLookupHash } from '../src/sentence-lookup.js';
import { completeAnalysis } from './support/fixtures.js';

test('example coverage deduplicates markup variants, excludes saved sentences and orders by lookup hash', () => {
  const items = [
    { type: 'vocab', data: { id: 'vocab-1', examples: ['This is a {{test}}.', 'Keep [[going]].', 'A third, plain one.'] } },
    { type: 'phrase', data: { id: 'phrase-1', vocabs: [{ id: 'nested', examples: ['This is a test.', '', 7] }] } },
    { type: 'sentence', data: { id: 'saved-1', text: 'Keep going.' } },
    // A deleted saved sentence no longer rules its example out, and a deleted card's examples are not expected.
    { type: 'sentence', isDeleted: true, data: { id: 'saved-2', text: 'A third, plain one.' } },
    { type: 'vocab', isDeleted: true, data: { id: 'deleted', examples: ['Deleted example.'] } },
  ];

  assert.deepEqual(
    collectExpectedExampleSentenceHashes(items),
    ['This is a test.', 'A third, plain one.'].map(sentenceLookupHash).sort((left, right) => left.localeCompare(right)),
  );
});

test('example coverage reports missing, incomplete, image, and complete gaps separately', () => {
  const examples = ['Complete example.', 'Incomplete example.', 'Missing example.'];
  const items = [{ type: 'vocab', data: { id: 'vocab-1', examples } }];
  const records = [
    {
      lookup_hash: sentenceLookupHash(examples[0]),
      analysis: JSON.stringify(completeAnalysis),
      image_content_hash: 'image-hash',
    },
    {
      lookup_hash: sentenceLookupHash(examples[1]),
      analysis: JSON.stringify({ ...completeAnalysis, pronunciation: undefined }),
      image_content_hash: null,
    },
  ];

  const coverage = summarizeExampleEnrichmentCoverage(items, records);
  assert.deepEqual({
    expected: coverage.expected,
    fullyEnriched: coverage.fullyEnriched,
    completeDetailedAnalysis: coverage.completeDetailedAnalysis,
    missingAnalysis: coverage.missingAnalysis,
    incompleteDetailedAnalysis: coverage.incompleteDetailedAnalysis,
    withImage: coverage.withImage,
    missingImage: coverage.missingImage,
  }, {
    expected: 3,
    fullyEnriched: 1,
    completeDetailedAnalysis: 1,
    missingAnalysis: 1,
    incompleteDetailedAnalysis: 1,
    withImage: 1,
    missingImage: 2,
  });
  assert.equal(coverage.missingAnalysisIds.length, 1);
  assert.equal(coverage.incompleteDetailedAnalysisIds.length, 1);
  assert.equal(coverage.missingImageIds.length, 2);
});
