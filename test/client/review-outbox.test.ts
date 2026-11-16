import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppliedReviewResponse } from '../../services/api/library.ts';
import { HttpError } from '../../services/http.ts';
import { drainReviewOutbox, reviewSeed, type ReviewOutboxDrain } from '../../services/reviewOutbox.ts';
import { isRefusedReviewMutation } from '../../services/refusedReviews.ts';
import type { PendingReviewMutation } from '../../services/reviewQueue.ts';
import type { SRSData, StoredItem } from '../../types.ts';

const schedule = (id: string, totalReviews: number): SRSData => ({
  id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews, correctStreak: 0, stability: 0.5,
});
const item = (id: string, serverRevision?: number): StoredItem => ({
  type: 'vocab',
  data: { id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: schedule(id, 3),
  savedAt: 1,
  ...(serverRevision === undefined ? {} : { serverRevision }),
});
const review = (eventId: string, itemId: string, reviewedAt: number): PendingReviewMutation => ({
  event: { id: eventId, itemId, itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 1 },
  itemIds: [itemId],
  optimisticSrs: { [itemId]: schedule(itemId, 1) },
});

/** An outbox in memory, recording what the drain did in order. */
function fakeOutbox(queued: PendingReviewMutation[], respond: (mutation: PendingReviewMutation) => Promise<AppliedReviewResponse>) {
  const outbox = [...queued];
  const log: string[] = [];
  let removable = true;
  let reads = 0;
  const drain: ReviewOutboxDrain = {
    read: () => { reads++; return [...outbox].sort((a, b) => a.event.reviewedAt - b.event.reviewedAt); },
    apply: async mutation => { log.push(`apply ${mutation.event.id}`); return respond(mutation); },
    isRefused: isRefusedReviewMutation,
    reconcile: async response => { log.push(`reconcile ${response.event.id}`); },
    recordRefusal: mutation => { log.push(`refused ${mutation.event.id}`); },
    remove: eventId => {
      log.push(`remove ${eventId}`);
      const index = outbox.findIndex(mutation => mutation.event.id === eventId);
      if (removable && index >= 0) outbox.splice(index, 1);
    },
    markUnsynced: async itemIds => { log.push(`unsynced ${itemIds.join(',')}`); },
  };
  return { drain, outbox, log, reads: () => reads, keepEverything: () => { removable = false; } };
}
const applied = (mutation: PendingReviewMutation): AppliedReviewResponse => ({ applied: true, event: mutation.event, items: [] });

test('applied reviews are reconciled and removed oldest first, including one queued while the drain runs', async () => {
  const fake = fakeOutbox([review('late', 'b', 20), review('early', 'a', 10)], async mutation => {
    if (mutation.event.id === 'early') fake.outbox.push(review('queued-meanwhile', 'c', 30));
    return applied(mutation);
  });
  await drainReviewOutbox(fake.drain);
  assert.deepEqual(fake.log, [
    'apply early', 'reconcile early', 'remove early',
    'apply late', 'reconcile late', 'remove late',
    'apply queued-meanwhile', 'reconcile queued-meanwhile', 'remove queued-meanwhile',
  ]);
  assert.deepEqual(fake.outbox, []);
  assert.equal(fake.reads(), 3, 'a pass for the two queued at the start, one for the review queued meanwhile, and the empty read');
});

test('the drain reads the outbox once per pass, not once per review', async () => {
  const fake = fakeOutbox([review('first', 'a', 10), review('second', 'b', 20), review('third', 'c', 30)], async mutation => applied(mutation));
  await drainReviewOutbox(fake.drain);
  assert.deepEqual(fake.log.filter(line => line.startsWith('apply')), ['apply first', 'apply second', 'apply third']);
  assert.equal(fake.reads(), 2, 'one pass, then the read that finds nothing left');

  const empty = fakeOutbox([], async mutation => applied(mutation));
  await drainReviewOutbox(empty.drain);
  assert.equal(empty.reads(), 1);
});

test('a refused review is recorded, removed and handed to the item push, and the drain goes on', async () => {
  const fake = fakeOutbox([review('refused', 'a', 10), review('next', 'b', 20)], async mutation => {
    if (mutation.event.id === 'refused') throw new HttpError('Conflict', 409, '');
    return applied(mutation);
  });
  await drainReviewOutbox(fake.drain);
  assert.deepEqual(fake.log, [
    'apply refused', 'refused refused', 'remove refused', 'unsynced a',
    'apply next', 'reconcile next', 'remove next',
  ]);
  assert.deepEqual(fake.outbox, []);
});

test('a passing failure stops the drain and keeps the rest queued for the next one', async () => {
  const fake = fakeOutbox([review('first', 'a', 10), review('second', 'b', 20)], async mutation => {
    throw new HttpError(`Unavailable: ${mutation.event.id}`, 503, '');
  });
  await assert.rejects(drainReviewOutbox(fake.drain), /Unavailable: first/);
  assert.deepEqual(fake.log, ['apply first']);
  assert.deepEqual(fake.outbox.map(mutation => mutation.event.id), ['first', 'second']);
  assert.equal(fake.reads(), 1);

  const offline = fakeOutbox([review('first', 'a', 10)], async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(drainReviewOutbox(offline.drain), /Failed to fetch/);
  assert.deepEqual(offline.log, ['apply first'], 'a network failure is not a refusal');
});

test('a review the outbox will not let go of is sent once per drain, not in a loop', async () => {
  const fake = fakeOutbox([review('stuck', 'a', 10), review('after', 'b', 20)], async mutation => applied(mutation));
  fake.keepEverything();
  await drainReviewOutbox(fake.drain);
  assert.deepEqual(fake.log, [
    'apply stuck', 'reconcile stuck', 'remove stuck',
    'apply after', 'reconcile after', 'remove after',
  ]);
  assert.equal(fake.reads(), 2, 'the second read finds only reviews already sent, and ends the drain');
});

test('an item the server has never stored travels with its review, holding the schedule from before it', () => {
  const offline = item('saved-offline');
  const before = schedule('saved-offline', 3);
  const seed = reviewSeed(offline, before);
  assert.ok(seed);
  assert.equal(seed.srs.totalReviews, 3, 'the pre-review schedule, not the reviewed one');
  assert.equal(seed.srs.id, 'saved-offline');
  assert.equal(seed.data, offline.data);
});

test('an item the server stored, even at revision 0, needs no seed, and a catalog seed is used as given', () => {
  assert.equal(reviewSeed(item('stored', 0), schedule('stored', 3)), undefined);
  assert.equal(reviewSeed(item('stored', 12), schedule('stored', 3)), undefined);

  const catalog = item('catalog-sentence');
  assert.equal(reviewSeed(item('stored', 12), schedule('stored', 3), catalog), catalog);
  assert.equal(reviewSeed(item('never-stored'), schedule('never-stored', 0), catalog), catalog);
});
