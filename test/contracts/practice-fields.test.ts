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

test('migrating or ensuring a schedule keeps its membership, whatever else it brings up to date', () => {
  const practicing = { practiceSince: 5, practiceChangedAt: 5 };
  // A fixed-schedule row from before display strength, and a never-reviewed sentence carrying a word's seed values.
  const legacy = { id: 'legacy', type: 'vocab', nextReview: 9, interval: 1440, lastReviewDate: 5, totalReviews: 2, correctStreak: 2,
    stability: 3, ...practicing } as SRSData;
  const sentence = { ...SRSAlgorithm.createNew('sentence', 'sentence', 1), stability: 9, memoryStrength: 42, sayableAt: 7, practiceChangedAt: 7 };
  assert.equal(SRSAlgorithm.needsMigration(legacy, 'vocab'), true);
  assert.deepEqual(membershipOf(SRSAlgorithm.migrate(legacy)), practicing);
  assert.deepEqual(membershipOf(SRSAlgorithm.ensure(legacy, 'legacy', 'vocab')), practicing);
  assert.deepEqual(membershipOf(SRSAlgorithm.migrate(sentence)), { sayableAt: 7, practiceChangedAt: 7 });
});

test("a device's merge takes the winning schedule whole, membership included, by every rule it merges by", () => {
  const at = (lastReviewDate: number, totalReviews: number, membership: Partial<SRSData>): SRSData =>
    ({ ...SRSAlgorithm.createNew('merged', 'vocab', 1), lastReviewDate, totalReviews, ...membership });
  const practicing = at(10, 2, { practiceSince: 10, practiceChangedAt: 10 });
  const sayable = at(20, 3, { sayableAt: 20, practiceChangedAt: 20 });
  const synced = (item: StoredItem, revision: number): StoredItem =>
    ({ ...item, serverRevision: revision, lastSyncedHash: getItemContentHash(item) });

  // A clean copy takes the server's schedule at a newer revision, even an older one (an undo elsewhere).
  const clean = synced(vocabItem('merged', sayable), 1);
  assert.deepEqual(membershipOf(mergeItem(clean, { ...vocabItem('merged', practicing), serverRevision: 2 }).srs), membershipOf(practicing));
  // An unsynced copy keeps its newer review, and loses to the server's newer one.
  const reviewedHere: StoredItem = { ...synced(vocabItem('merged', practicing), 1), srs: sayable };
  assert.deepEqual(membershipOf(mergeItem(reviewedHere, { ...vocabItem('merged', practicing), serverRevision: 2 }).srs), membershipOf(sayable));
  const editedHere: StoredItem = { ...synced(vocabItem('merged', practicing), 1), updatedAt: 5 };
  assert.deepEqual(membershipOf(mergeItem(editedHere, { ...vocabItem('merged', sayable), serverRevision: 2 }).srs), membershipOf(sayable));
  // A newer passive listen merges in beside it.
  const listened = { ...vocabItem('merged', { ...practicing, lastExposureDate: 99 }), serverRevision: 2 };
  const merged = mergeItem(clean, listened).srs;
  assert.equal(merged.lastExposureDate, 99);
  assert.deepEqual(membershipOf(merged), membershipOf(practicing));
});

test('the optimistic schedule a queued review left, laid over the library at launch, keeps its membership', () => {
  const item = vocabItem('overlaid');
  const { copy, event } = recordReview(item, 'again', 1_000, 'triage');
  const [overlaid] = overlayPendingReviews([item], [{ event, itemIds: ['overlaid'], optimisticSrs: { overlaid: copy.srs } }]);
  assert.deepEqual(membershipOf(overlaid.srs), { practiceSince: 1_000, practiceChangedAt: 1_000 });
});

test('membership made on one device reaches another through the review, a push and a pull, and an undo takes it back on both', () => {
  upsertItem(vocabItem('round-trip'), USER);
  const now = Date.now();
  // Device A puts the item in practice; its outbox delivers the review.
  let deviceA = pulled('round-trip');
  const join = recordReview(deviceA, 'again', now - 3 * MINUTE, 'triage');
  deviceA = deliver(join.copy, join.event);
  assert.deepEqual(membershipOf(deviceA.srs), { practiceSince: now - 3 * MINUTE, practiceChangedAt: now - 3 * MINUTE });
  assert.equal(isItemDirty(deviceA), false);
  // A content edit on A carries the schedule in its push, and the server keeps the membership.
  deviceA = push({ ...deviceA, data: { ...deviceA.data, mnemonic: 'my note' }, updatedAt: now - 2 * MINUTE });
  // Device B pulls it, then gives it a Got it, which schedules but changes no membership.
  let deviceB = pulled('round-trip');
  assert.deepEqual(membershipOf(deviceB.srs), membershipOf(deviceA.srs));
  const gotIt = recordReview(deviceB, 'good', now - MINUTE, 'quick');
  deviceB = deliver(gotIt.copy, gotIt.event);
  assert.equal(deviceB.srs.totalReviews, 2);
  assert.deepEqual(membershipOf(deviceB.srs), membershipOf(deviceA.srs));
  // B marks it as one it can say, then takes that back.
  const sayable = recordReview(deviceB, 'easy', now, 'triage');
  deviceB = deliver(sayable.copy, sayable.event);
  assert.deepEqual(membershipOf(deviceB.srs), { sayableAt: now, practiceChangedAt: now });
  const undone = undoReviewEvent(sayable.event.id, USER)!;
  deviceB = reconcileReviewedItem(deviceB, asClientItem(undone.items[0]), undone.baseRevisions['round-trip']);
  assert.deepEqual(membershipOf(deviceB.srs), membershipOf(deviceA.srs));
  // A's next pull agrees.
  const fromServer = pulled('round-trip');
  deviceA = trackServerContent(mergeDatasets([deviceA], [fromServer]), [fromServer])[0];
  assert.deepEqual(deviceA.srs, deviceB.srs);
  assert.deepEqual(membershipOf(deviceA.srs), { practiceSince: now - 3 * MINUTE, practiceChangedAt: now - 3 * MINUTE });
});
