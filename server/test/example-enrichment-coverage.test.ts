import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectExpectedExampleSentenceHashes,
  readStoredExampleCoverage,
  summarizeExampleEnrichmentCoverage,
  type StoredSentenceEnrichmentRecord,
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
  const records: StoredSentenceEnrichmentRecord[] = [
    {
      lookup_hash: sentenceLookupHash(examples[0]),
      analysis: JSON.stringify(completeAnalysis),
      image_content_hash: 'image-hash',
      image_bytes: 1_000,
      updated_at: 1,
    },
    {
      lookup_hash: sentenceLookupHash(examples[1]),
      analysis: JSON.stringify({ ...completeAnalysis, pronunciation: undefined }),
      image_content_hash: null,
      image_bytes: null,
      updated_at: 1,
    },
  ];

  const { coverage: stored } = readStoredExampleCoverage(records, new Set(collectExpectedExampleSentenceHashes(items)));
  const coverage = summarizeExampleEnrichmentCoverage(items, stored);
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

test('one read of the stored rows flags each expected example and notes the newest publication', () => {
  const row = (text: string, analysis: string, imageBytes: number | null, updatedAt: number, imageHash = imageBytes === null ? null : 'h') => ({
    lookup_hash: sentenceLookupHash(text), analysis, image_content_hash: imageHash, image_bytes: imageBytes, updated_at: updatedAt,
  });
  const complete = JSON.stringify(completeAnalysis);
  const records: StoredSentenceEnrichmentRecord[] = [
    row('Complete with an image.', complete, 2_000, 30),
    row('Complete, but its image is empty.', complete, 0, 10),
    row('Complete, but its blob is gone.', complete, null, 10, 'gone'),
    row('Stored as broken JSON.', '{"translation":', null, 10),
    // Not expected: skipped, though its time still counts as the newest publication.
    row('Nothing expects this one.', '{"translation":', null, 50),
  ];
  const expected = new Set(records.slice(0, 4).map(record => record.lookup_hash));

  const { coverage, latestUpdatedAt } = readStoredExampleCoverage(records, expected);
  assert.equal(latestUpdatedAt, 50);
  assert.deepEqual([...coverage.values()], [1 | 2 | 4, 1 | 2, 1 | 2, 1]);
  assert.equal(coverage.has(sentenceLookupHash('Nothing expects this one.')), false);
  assert.deepEqual(readStoredExampleCoverage([], expected), { coverage: new Map(), latestUpdatedAt: 0 });
});
