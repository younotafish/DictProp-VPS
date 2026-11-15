import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGeneratedVocabIntoStoredItem } from '../../services/items.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

const saved: StoredItem = {
  type: 'vocab',
  data: {
    id: 'saved-id', word: 'visceral', sense: 'adj: instinctive', chinese: '', ipa: '',
    definition: 'old', synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '',
  },
  srs: {
    id: 'saved-id', type: 'vocab', nextReview: 9, interval: 8, memoryStrength: 7,
    lastReviewDate: 6, totalReviews: 5, correctStreak: 4, stability: 3,
  },
  savedAt: 1,
};

test('a late illustration attaches to the saved identity without resetting learning', () => {
  const generated: VocabCard = {
    ...(saved.data as VocabCard),
    id: 'temporary-ai-id',
    definition: 'new',
    imageUrl: 'data:image/jpeg;base64,/9j/',
  };
  const merged = mergeGeneratedVocabIntoStoredItem([saved], generated);

  assert.equal(merged?.data.id, 'saved-id');
  assert.equal((merged?.data as VocabCard).imageUrl, generated.imageUrl);
  assert.equal((merged?.data as VocabCard).definition, 'old');
  assert.deepEqual(merged?.srs, saved.srs);
  assert.equal(merged?.savedAt, saved.savedAt);
});
