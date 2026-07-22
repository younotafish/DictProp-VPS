import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectIncrementalEnrichmentItems,
  hasCompleteVocabContent,
  selectReplacementVocab,
} from '../src/incremental-enrichment.js';

const completeVocab = {
  id: 'word',
  word: 'word',
  chinese: '词',
  ipa: '/wɝd/',
  definition: 'A unit of language.',
  history: 'An old word.',
  register: 'common',
  mnemonic: 'Remember word.',
  imagePrompt: 'A word icon',
  synonyms: [],
  antonyms: [],
  confusables: [],
  examples: ['One word works.', 'That is the word.'],
};

test('incremental enrichment selects only unfinished records added after installation', () => {
  const items = [
    { type: 'sentence', savedAt: 99, data: { id: 'legacy', text: 'Old.', sourceWord: '' } },
    { type: 'vocab', savedAt: 101, data: { ...completeVocab, id: 'complete', imageUrl: 'server:has_image' } },
    { type: 'sentence', savedAt: 103, data: { id: 'new-sentence', text: 'New.', sourceWord: '' } },
    { type: 'vocab', savedAt: 102, data: { id: 'new-word', word: 'new' } },
    { type: 'sentence', savedAt: 104, isArchived: true, data: { id: 'archived', text: 'Skip.', sourceWord: '' } },
  ];

  assert.deepEqual(
    collectIncrementalEnrichmentItems(items, 100, 10).map(item => item.data.id),
    ['new-word', 'new-sentence'],
  );
  assert.deepEqual(
    collectIncrementalEnrichmentItems(items, 100, 1).map(item => item.data.id),
    ['new-word'],
  );
});

test('vocabulary completeness and sense-matched replacement are deterministic', () => {
  assert.equal(hasCompleteVocabContent(completeVocab), true);
  assert.equal(hasCompleteVocabContent({ ...completeVocab, examples: ['only one'] }), false);
  const replacement = selectReplacementVocab(
    { word: 'bank', sense: 'verb: rely' },
    [
      { word: 'bank', sense: 'noun: finance' },
      { word: 'bank', sense: 'verb: rely' },
    ],
  );
  assert.equal(replacement?.sense, 'verb: rely');
});
