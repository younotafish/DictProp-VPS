import assert from 'node:assert/strict';
import test from 'node:test';

// Today's practice membership lives in three optional schedule fields (server/src/shared/practice.ts). Everything that
// rebuilds, merges, stores or restores a schedule must carry them whole, and a reset must still win over a review that
// was waiting to be sent when it was made.
const { applyReviewEvent, getItemsAfterRevision, undoReviewEvent, upsertItem, upsertMany } = await import('../../server/src/db.js');
const { applyServerSave, mergeDatasets, mergeItem, reconcileReviewedItem, trackServerContent } = await import('../../services/sync.ts');
const { getItemContentHash, isItemDirty } = await import('../../services/itemHash.ts');
const { SRSAlgorithm } = await import('../../services/srsAlgorithm.ts');
const { updateAfterRating } = await import('../../services/fsrsScheduler.ts');
const { overlayPendingReviews } = await import('../../services/reviewQueue.ts');
import type { StoredItemRecord } from '../../server/src/db.js';
import type { ReviewEvent, ReviewRating, ReviewTaskType, SRSData, StoredItem } from '../../types.ts';

const USER = 'practice-fields-user';
const MINUTE = 60_000;
const DAY = 86_400_000;
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const asClientItem = (item: StoredItemRecord): StoredItem => JSON.parse(JSON.stringify(item));
const membershipOf = (srs: object | undefined) => Object.fromEntries(['practiceSince', 'sayableAt', 'practiceChangedAt']
  .filter(key => srs && key in srs).map(key => [key, (srs as Record<string, unknown>)[key]]));

function vocabItem(id: string, srs: SRSData = SRSAlgorithm.createNew(id, 'vocab', 1)): StoredItem {
  return {
    type: 'vocab', savedAt: 1, updatedAt: 1,
    data: {
      id, word: id, chinese: '', ipa: '', definition: `definition ${id}`,
      synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
    },
    srs,
  };
}

/** The server's copy of an item, as a pull hands it to a device. */
function pulled(id: string): StoredItem {
  const items = getItemsAfterRevision({ revision: 0, id: '' }, 500, USER).items.filter(item => item.data.id === id).map(asClientItem);
  return trackServerContent(mergeDatasets([], items), items)[0];
}

/**
 * A review as useReviewOutbox records it: the device's optimistic schedule, with the copy marked clean when it was
 * clean before (the outbox, not the push, carries the review), and the event the outbox will send.
 */
function recordReview(item: StoredItem, rating: ReviewRating, at: number, taskType?: ReviewTaskType) {
  const base = SRSAlgorithm.ensure(item.srs, item.data.id, item.type);
  const srs = updateAfterRating(base, rating, at, taskType);
  const reviewed: StoredItem = { ...item, srs: { ...srs, id: item.data.id }, updatedAt: at };
  const event: ReviewEvent = {
    id: `${item.data.id}-review-${at}`, itemId: item.data.id, itemType: item.type, reviewedAt: at,
    previousStep: base.totalReviews, nextStep: srs.totalReviews, rating, taskType: taskType ?? 'quick',
  };
  const copy = isItemDirty(item) ? reviewed : { ...reviewed, lastSyncedHash: getItemContentHash(reviewed) };
  return { copy, event };
}

/** The outbox delivering a review: the server applies it, and the device reconciles its copy with the reply. */
function deliver(local: StoredItem, event: ReviewEvent): StoredItem {
  const applied = applyReviewEvent(event, [event.itemId], USER);
  assert.ok(applied?.applied, 'the server applied the review');
  return reconcileReviewedItem(local, asClientItem(applied.items[0]), applied.baseRevisions[event.itemId]);
}

/** A device's push of its dirty copy, and the copy the server's reply leaves. */
function push(local: StoredItem): StoredItem {
  const result = wire(upsertMany(wire([local]), USER));
  return applyServerSave([local], [local], {
    revisions: new Map(Object.entries(result.revisions)), canonical: new Map(), kept: new Map(Object.entries(result.kept)),
  })[0];
}

test('a reset made while a review waits in the outbox survives the review landing, and its push reaches every device', () => {
  upsertItem(vocabItem('reset-pending'), USER);
  const now = Date.now();
  // Put in practice on this device while offline; the review waits in the outbox, so nothing pushes the item.
  const { copy, event } = recordReview(pulled('reset-pending'), 'again', now - 2 * MINUTE, 'triage');
  assert.ok(copy.srs.practiceSince !== undefined);
  // Then reset here. The push skips the item while its review is queued (excludePendingReviewItems).
  const reset: StoredItem = { ...copy, srs: SRSAlgorithm.reset('reset-pending', 'vocab', now - MINUTE), updatedAt: now - MINUTE };
  assert.equal(isItemDirty(reset), true);

  const reconciled = deliver(reset, event);
  assert.equal(reconciled.srs.totalReviews, 0);
  assert.equal(reconciled.srs.lastReviewDate, now - MINUTE);
  assert.deepEqual(membershipOf(reconciled.srs), {});
  assert.equal(isItemDirty(reconciled), true, 'the reset still has to be pushed');

  const synced = push(reconciled);
  assert.equal(isItemDirty(synced), false);
  const elsewhere = pulled('reset-pending');
  assert.equal(elsewhere.srs.totalReviews, 0);
  assert.deepEqual(membershipOf(elsewhere.srs), {});
});

test('a review whose own schedule is newer than the copy, or an undo moving it back, is still installed from the server', () => {
  // A reset before the review: the review's schedule is the newer one.
  upsertItem(vocabItem('reset-then-review'), USER);
  const now = Date.now();
  const resetFirst: StoredItem = {
    ...pulled('reset-then-review'), srs: SRSAlgorithm.reset('reset-then-review', 'vocab', now - 3 * MINUTE), updatedAt: now - 3 * MINUTE,
  };
  const synced = push(resetFirst);
  const { copy, event } = recordReview(synced, 'easy', now - 2 * MINUTE, 'triage');
  const reconciled = deliver(copy, event);
  assert.equal(reconciled.srs.totalReviews, 1);
  assert.deepEqual(membershipOf(reconciled.srs), { sayableAt: now - 2 * MINUTE, practiceChangedAt: now - 2 * MINUTE });
  assert.equal(isItemDirty(reconciled), false);

  // Undone: the server's older schedule replaces the reviewed copy, membership and all.
  const undone = undoReviewEvent(event.id, USER)!;
  const restored = reconcileReviewedItem(reconciled, asClientItem(undone.items[0]), undone.baseRevisions['reset-then-review']);
  assert.equal(restored.srs.totalReviews, 0);
  assert.equal(restored.srs.lastReviewDate, now - 3 * MINUTE);
  assert.deepEqual(membershipOf(restored.srs), {});
  assert.equal(isItemDirty(restored), false);
});

test('a reset made here survives an undo of the review before it, which the server took back meanwhile', () => {
  upsertItem(vocabItem('undo-under-reset'), USER);
  const now = Date.now();
  const { copy, event } = recordReview(pulled('undo-under-reset'), 'again', now - 2 * MINUTE, 'triage');
  const reviewed = deliver(copy, event);
  // Reset here (held by its undo pill, so not pushed yet); then the review is undone, here or on another device.
  const reset: StoredItem = { ...reviewed, srs: SRSAlgorithm.reset('undo-under-reset', 'vocab', now - MINUTE), updatedAt: now - MINUTE };
  const undone = undoReviewEvent(event.id, USER)!;
  const reconciled = reconcileReviewedItem(reset, asClientItem(undone.items[0]), undone.baseRevisions['undo-under-reset']);
  assert.equal(reconciled.srs.lastReviewDate, now - MINUTE);
  assert.equal(isItemDirty(reconciled), true);
  assert.equal(pulled('undo-under-reset').srs.lastReviewDate, 0);
  push(reconciled);
  assert.equal(pulled('undo-under-reset').srs.lastReviewDate, now - MINUTE);
});
