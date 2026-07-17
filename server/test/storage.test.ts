import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const { loadData, saveData, saveItemUpdates } = await import('../../services/storage.ts');

const item = (id: string, reviews: number) => ({
  type: 'vocab' as const,
  data: {
    id,
    word: id,
    chinese: '',
    ipa: '',
    definition: '',
    synonyms: [],
    antonyms: [],
    confusables: [],
    examples: [],
    history: '',
    register: '',
    mnemonic: '',
  },
  srs: {
    id,
    type: 'vocab' as const,
    nextReview: reviews,
    interval: reviews,
    memoryStrength: reviews,
    lastReviewDate: reviews,
    totalReviews: reviews,
    correctStreak: reviews,
    stability: reviews,
  },
  savedAt: 1,
  updatedAt: reviews,
});

test('item update journal overlays and compacts into the full snapshot', async () => {
  const userId = 'journal-user';
  await saveData([item('one', 1), item('two', 1)], userId);
  await saveItemUpdates([item('one', 2)], userId);

  const overlaid = await loadData(userId);
  assert.equal(overlaid.find(value => value.data.id === 'one')?.srs.totalReviews, 2);
  assert.equal(overlaid.find(value => value.data.id === 'two')?.srs.totalReviews, 1);

  await saveData(overlaid, userId);
  const compacted = await loadData(userId);
  assert.deepEqual(compacted, overlaid);
});
