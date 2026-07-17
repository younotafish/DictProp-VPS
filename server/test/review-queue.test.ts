import assert from 'node:assert/strict';
import test from 'node:test';
import type { PendingReviewMutation } from '../../services/reviewQueue.ts';
import { enqueuePendingReviewMutation, overlayPendingReviews, readPendingReviewMutations, removePendingReviewMutation } from '../../services/reviewQueue.ts';
import type { StoredItem } from '../../types.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const baseItem: StoredItem = {
  type: 'vocab',
  data: { id: 'one', word: 'one', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id: 'one', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
};

test('pending reviews survive reload, overlay progress, and clear by event id', () => {
  const storage = new MemoryStorage();
  const srs = { ...baseItem.srs, lastReviewDate: 10, totalReviews: 1 };
  const mutation: PendingReviewMutation = {
    event: { id: 'event-1', itemId: 'one', itemType: 'vocab', reviewedAt: 10, previousStep: 0, nextStep: 1 },
    itemIds: ['one'],
    optimisticSrs: { one: srs },
  };

  enqueuePendingReviewMutation('user', mutation, storage);
  assert.deepEqual(readPendingReviewMutations('user', storage), [mutation]);
  assert.equal(overlayPendingReviews([baseItem], [mutation])[0].srs.totalReviews, 1);
  removePendingReviewMutation('user', 'event-1', storage);
  assert.deepEqual(readPendingReviewMutations('user', storage), []);
});
