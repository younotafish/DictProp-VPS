import assert from 'node:assert/strict';
import test from 'node:test';
import type { PendingReviewMutation } from '../../services/reviewQueue.ts';
import { HttpError } from '../../services/http.ts';
import { enqueuePendingReviewMutation, isRefusedReviewMutation, overlayPendingReviews, readPendingReviewMutations, removePendingReviewMutation } from '../../services/reviewQueue.ts';
import type { StoredItem } from '../../types.ts';

class MemoryStorage {
  protected values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
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

const review = (id: string, reviewedAt: number): PendingReviewMutation => ({
  event: { id, itemId: 'one', itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 1 },
  itemIds: ['one'],
  optimisticSrs: { one: { ...baseItem.srs, lastReviewDate: reviewedAt, totalReviews: 1 } },
});
const ids = (mutations: PendingReviewMutation[]) => mutations.map(mutation => mutation.event.id);

test('two tabs queueing and delivering reviews at once keep every review', () => {
  // Each tab reads its own copy of localStorage, which the other tab's writes reach a moment later.
  const shared = new Map<string, string>();
  class TabStorage extends MemoryStorage {
    constructor() { super(); this.catchUp(); }
    catchUp() { this.values = new Map(shared); }
    setItem(key: string, value: string) { super.setItem(key, value); shared.set(key, value); }
    removeItem(key: string) { super.removeItem(key); shared.delete(key); }
  }
  const first = new TabStorage();
  const second = new TabStorage();

  enqueuePendingReviewMutation('user', review('a', 1), first);
  second.catchUp();
  enqueuePendingReviewMutation('user', review('b', 2), first);
  // The second tab delivers "a" before it hears of "b", then queues a review of its own.
  removePendingReviewMutation('user', 'a', second);
  enqueuePendingReviewMutation('user', review('c', 3), second);

  assert.deepEqual(ids(readPendingReviewMutations('user', new TabStorage())), ['b', 'c']);
});

test('reviews an older build queued in one array are still sent, in the order they were made, and drain', () => {
  const storage = new MemoryStorage();
  storage.setItem('review_mutations_pending_user', JSON.stringify([review('old-2', 2), review('old-1', 1)]));
  enqueuePendingReviewMutation('user', review('new', 3), storage);
  enqueuePendingReviewMutation('user', review('earlier', 0), storage);
  // A review under another review's key could never be removed, so it isn't sent.
  storage.setItem('review_mutations_pending_user:stray', JSON.stringify(review('elsewhere', 4)));
  enqueuePendingReviewMutation('another-user', review('theirs', 1), storage);

  assert.deepEqual(ids(readPendingReviewMutations('user', storage)), ['earlier', 'old-1', 'old-2', 'new']);
  removePendingReviewMutation('user', 'old-2', storage);
  assert.deepEqual(ids(JSON.parse(storage.getItem('review_mutations_pending_user')!)), ['old-1']);
  removePendingReviewMutation('user', 'old-1', storage);
  removePendingReviewMutation('user', 'new', storage);
  removePendingReviewMutation('user', 'earlier', storage);
  assert.equal(storage.getItem('review_mutations_pending_user'), null, 'the old array is gone once empty');
  assert.deepEqual(readPendingReviewMutations('user', storage), []);
  assert.deepEqual(ids(readPendingReviewMutations('another-user', storage)), ['theirs']);
});
