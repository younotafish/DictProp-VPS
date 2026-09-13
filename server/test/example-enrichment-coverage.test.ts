import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectExpectedExampleSentenceHashes,
  collectExpectedExampleSentences,
  summarizeExampleEnrichmentCoverage,
} from '../src/example-enrichment-coverage.js';
import { sentenceLookupHash } from '../src/sentence-enrichment.js';

const completeAnalysis = {
  translation: '这是一个例句。',
  naturalSpeechIpa: '/ðɪs ɪz ə tɛst/',
  grammar: { structure: 'A simple declarative clause.', points: [] },
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. This is natural in American English.',
    evidence: ['The wording is current and idiomatic.'],
  },
  terms: [],
  pronunciation: {
    slowIpa: '/ðɪs ɪz ə tɛst/',
    fastIpa: '/ðɪs ɪz ə tɛst/',
    carefulSpeakerGuide: 'this IS a TEST',
    fastSpeechFeatures: ['The article is reduced in fluent speech.'],
    intonationAndChunking: 'Use one thought group with a final fall.',
    keyDifference: 'Fluent speech reduces the unstressed article.',
  },
  imagePrompt: 'A photorealistic wide image of a student completing a short test at a desk, with no visible text.',
};

test('example coverage deduplicates markup variants and excludes saved sentences', () => {
  const items = [
    { type: 'vocab', data: { id: 'vocab-1', examples: ['This is a {{test}}.', 'Keep [[going]].'] } },
    { type: 'phrase', data: { id: 'phrase-1', vocabs: [{ id: 'nested', examples: ['This is a test.'] }] } },
    { type: 'sentence', data: { id: 'saved-1', text: 'Keep going.' } },
    { type: 'vocab', isDeleted: true, data: { id: 'deleted', examples: ['Deleted example.'] } },
  ];

  assert.deepEqual(collectExpectedExampleSentenceHashes(items), [sentenceLookupHash('This is a test.')]);
  assert.deepEqual(collectExpectedExampleSentences(items), [{
    id: `example-${sentenceLookupHash('This is a test.').slice(0, 40)}`,
    text: 'This is a {{test}}.',
    lookupHash: sentenceLookupHash('This is a test.'),
  }]);
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
