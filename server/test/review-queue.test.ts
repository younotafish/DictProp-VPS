import assert from 'node:assert/strict';
import test from 'node:test';
import type { PendingReviewMutation } from '../../services/reviewQueue.ts';
import { HttpError } from '../../services/http.ts';
import { enqueuePendingReviewMutation, isRefusedReviewMutation, overlayPendingReviews, readPendingReviewMutations, removePendingReviewMutation } from '../../services/reviewQueue.ts';
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

test('an outbox that cannot store a review says so, and refusals are told apart from passing failures', () => {
  class FullStorage extends MemoryStorage {
    setItem() { throw new Error('QuotaExceededError'); }
  }
  const mutation: PendingReviewMutation = {
    event: { id: 'event-full', itemId: 'one', itemType: 'vocab', reviewedAt: 10, previousStep: 0, nextStep: 1 },
    itemIds: ['one'],
    optimisticSrs: { one: { ...baseItem.srs, lastReviewDate: 10, totalReviews: 1 } },
  };
  assert.equal(enqueuePendingReviewMutation('user', mutation, new MemoryStorage()), true);
  assert.equal(enqueuePendingReviewMutation('user', mutation, new FullStorage()), false);
  assert.equal(enqueuePendingReviewMutation('user', mutation, null), false);

  for (const status of [400, 404, 409, 413]) {
    assert.equal(isRefusedReviewMutation(new HttpError('Refused', status, '')), true, String(status));
  }
  for (const status of [401, 403, 408, 429, 500, 503]) {
    assert.equal(isRefusedReviewMutation(new HttpError('Failed', status, '')), false, String(status));
  }
  assert.equal(isRefusedReviewMutation(new TypeError('Failed to fetch')), false);
});
