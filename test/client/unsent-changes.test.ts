import assert from 'node:assert/strict';
import test from 'node:test';
import { getItemContentHash } from '../../services/itemHash.ts';
import { hasUnsentChanges, isUnsent, selectUnsent, sendBeforeLeaving, type PushHold } from '../../services/unsentChanges.ts';
import type { StoredItem } from '../../types.ts';

const card = (id: string, definition = `definition of ${id}`): StoredItem => ({
  type: 'vocab',
  data: { id, word: id, chinese: '', ipa: '', definition, synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});
/** A copy the server has acknowledged. */
const synced = (item: StoredItem): StoredItem => ({ ...item, lastSyncedHash: getItemContentHash(item) });
const edited = (item: StoredItem, definition: string): StoredItem => ({ ...item, data: { ...item.data, definition } as StoredItem['data'] });
const noHold: PushHold = { heldId: null, refused: new Map() };

test('only a change the server has not acknowledged is unsent', () => {
  assert.equal(isUnsent(card('new'), noHold), true, 'never pushed');
  assert.equal(isUnsent(synced(card('clean')), noHold), false);
  assert.equal(isUnsent(edited(synced(card('edited')), 'changed'), noHold), true);
});

test('an item held for an undo, or refused at its current content, waits; one edited after the refusal goes again', () => {
  const held = edited(synced(card('held')), 'deleted, maybe');
  assert.equal(isUnsent(held, { ...noHold, heldId: 'held' }), false);
  assert.equal(isUnsent(held, { ...noHold, heldId: 'another' }), true);

  const refusedCopy = edited(synced(card('refused')), 'too large');
  const refused = new Map([['refused', getItemContentHash(refusedCopy)]]);
  assert.equal(isUnsent(refusedCopy, { heldId: null, refused }), false);
  assert.equal(isUnsent(edited(refusedCopy, 'fixed'), { heldId: null, refused }), true);
});

test('a push selects the unsent items, among the given ids when there are some', () => {
  const items = [card('a'), synced(card('b')), card('c'), card('held')];
  const hold: PushHold = { heldId: 'held', refused: new Map() };
  assert.deepEqual(selectUnsent(items, hold).map(item => item.data.id), ['a', 'c']);
  assert.deepEqual(selectUnsent(items, hold, new Set(['c', 'b', 'held'])).map(item => item.data.id), ['c']);
});

test('changes are waiting while an undo is on offer, a review is queued, or an item is unsent; refused ones do not count', () => {
  const clean = [synced(card('a'))];
  let reviewReads = 0;
  const noReviews = () => { reviewReads++; return 0; };

  assert.equal(hasUnsentChanges(clean, noHold, noReviews), false);
  assert.equal(hasUnsentChanges(clean, noHold, () => 1), true, 'a queued review');
  assert.equal(hasUnsentChanges([...clean, card('b')], noHold, noReviews), true, 'an unsent item');

  reviewReads = 0;
  assert.equal(hasUnsentChanges(clean, { ...noHold, heldId: 'a' }, noReviews), true, 'an open undo offer');
  assert.equal(reviewReads, 0, 'an open undo offer answers without reading the outbox');

  const refusedCopy = card('refused');
  const refused = new Map([['refused', getItemContentHash(refusedCopy)]]);
  assert.equal(hasUnsentChanges([...clean, refusedCopy], { heldId: null, refused }, noReviews), false);
});

test('leaving closes the undo offer, then saves, sends the reviews and pushes, in that order', async () => {
  const steps: string[] = [];
  await sendBeforeLeaving({
    closeUndoOffer: () => { steps.push('close undo offer'); },
    saveLocal: async () => { steps.push('save'); },
    flushReviews: async () => { steps.push('reviews'); },
    push: async () => { steps.push('push'); },
    timeoutMs: 1_000,
    onError: error => { throw error; },
  });
  steps.push('sign out');
  assert.deepEqual(steps, ['close undo offer', 'save', 'reviews', 'push', 'sign out']);
});

test('with nothing to save, the reviews start at once', () => {
  const steps: string[] = [];
  void sendBeforeLeaving({
    closeUndoOffer: () => {},
    saveLocal: () => undefined,
    flushReviews: async () => { steps.push('reviews'); },
    push: async () => {},
    timeoutMs: 1_000,
    onError: () => {},
  });
  assert.deepEqual(steps, ['reviews'], 'started before sendBeforeLeaving returned');
});

test('a failed step is reported and stops the rest, and leaving still goes ahead', async () => {
  const steps: string[] = [];
  const errors: unknown[] = [];
  await sendBeforeLeaving({
    closeUndoOffer: () => {},
    saveLocal: async () => { throw new Error('storage full'); },
    flushReviews: async () => { steps.push('reviews'); },
    push: async () => { steps.push('push'); },
    timeoutMs: 1_000,
    onError: error => { errors.push(error); },
  });
  assert.deepEqual(steps, []);
  assert.match(String(errors[0]), /storage full/);
});

test('a server that never answers holds leaving up for timeoutMs at most', async () => {
  const started = Date.now();
  let pushes = 0;
  await sendBeforeLeaving({
    closeUndoOffer: () => {},
    saveLocal: () => undefined,
    flushReviews: async () => {},
    push: () => { pushes++; return new Promise(() => {}); },
    timeoutMs: 30,
    onError: () => {},
  });
  assert.equal(pushes, 1);
  assert.ok(Date.now() - started < 1_000, 'gave up after the timeout');
});
