import assert from 'node:assert/strict';
import test from 'node:test';
import { getItemContentHash, isItemDirty } from '../../services/itemHash.ts';
import { needsSrsMigration, prepareStoredLibrary } from '../../services/libraryLaunch.ts';
import type { PendingReviewMutation } from '../../services/reviewQueue.ts';
import type { RevisionCursor, SRSData, StoredItem } from '../../types.ts';

const NOW = 1_700_000_000_000;
const cursor: RevisionCursor = { revision: 42, id: 'last' };
const schedule = (id: string, overrides: Partial<SRSData> = {}): SRSData => ({
  id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5,
  ...overrides,
});
const card = (id: string, overrides: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab',
  data: { id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: schedule(id),
  savedAt: 1,
  updatedAt: 1,
  ...overrides,
});
const synced = (item: StoredItem): StoredItem => ({ ...item, lastSyncedHash: getItemContentHash(item) });
const review = (itemId: string, reviewedAt: number): PendingReviewMutation => ({
  event: { id: `review-${itemId}`, itemId, itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 1 },
  itemIds: [itemId],
  optimisticSrs: { [itemId]: schedule(itemId, { lastReviewDate: reviewedAt, totalReviews: 1, memoryStrength: 10, stability: 2 }) },
});

test('a current library comes back as stored: same items, same cursor', () => {
  const items = [synced(card('a')), card('b')];
  const prepared = prepareStoredLibrary({ items, cursor }, [], NOW);
  assert.equal(prepared.cursor, cursor);
  assert.equal(prepared.items.length, 2);
  prepared.items.forEach((item, index) => assert.equal(item, items[index], 'an unchanged item keeps its identity'));
});

test('a record without an id, schedule or type is left out, and the cursor with it, so a full sync restores it', () => {
  const kept = card('kept');
  const noSchedule = { ...card('no-schedule'), srs: undefined } as unknown as StoredItem;
  const noType = { ...card('no-type'), type: undefined } as unknown as StoredItem;
  const prepared = prepareStoredLibrary({ items: [kept, noSchedule, noType, null as unknown as StoredItem], cursor }, [], NOW);
  assert.deepEqual(prepared.items, [kept]);
  assert.equal(prepared.items[0], kept);
  assert.equal(prepared.cursor, null);
});

test('old schedules are migrated, and so are never-reviewed sentences carrying other starting values', () => {
  assert.equal(needsSrsMigration(schedule('a'), 'vocab'), false);
  assert.equal(needsSrsMigration({ ...schedule('a'), memoryStrength: undefined } as unknown as SRSData, 'vocab'), true);
  assert.equal(needsSrsMigration(schedule('s', { type: 'sentence', memoryStrength: 30 }), 'sentence'), true);
  assert.equal(needsSrsMigration(schedule('s', { type: 'sentence', stability: 2 }), 'sentence'), true);
  assert.equal(needsSrsMigration(schedule('s', { type: 'sentence', memoryStrength: 30, totalReviews: 4 }), 'sentence'), false);

  const legacy = card('legacy', { srs: { ...schedule('legacy'), memoryStrength: undefined } as unknown as SRSData });
  const [migrated] = prepareStoredLibrary({ items: [legacy], cursor }, [], NOW).items;
  assert.notEqual(migrated, legacy);
  assert.equal(typeof migrated.srs.memoryStrength, 'number');
  assert.equal(migrated.data, legacy.data, 'the card itself is untouched');
});

test('a record without timestamps takes the launch time, and the legacy project field goes', () => {
  const undated = card('undated', { savedAt: 0, updatedAt: undefined });
  const inProject = card('in-project', { project: 'travel' } as Partial<StoredItem>);
  const [dated, merged] = prepareStoredLibrary({ items: [undated, inProject], cursor }, [], NOW).items;
  assert.equal(dated.savedAt, NOW);
  assert.equal(dated.updatedAt, NOW);
  assert.equal('project' in merged, false);
  assert.equal(merged.data, inProject.data);
  assert.equal(merged.srs, inProject.srs);
});

test('a queued review is laid over the stored copy: a clean copy stays clean, a dirty one stays dirty', () => {
  const clean = synced(card('clean'));
  const dirty = { ...synced(card('dirty')), data: { ...card('dirty').data, definition: 'edited offline' } };
  const untouched = synced(card('untouched'));
  const prepared = prepareStoredLibrary(
    { items: [clean, dirty, untouched], cursor },
    [review('clean', 500), review('dirty', 600)],
    NOW,
  );
  const [reviewedClean, reviewedDirty, same] = prepared.items;

  assert.equal(reviewedClean.srs.totalReviews, 1);
  assert.equal(isItemDirty(reviewedClean), false, 'the outbox delivers the review, so the copy stays clean');
  assert.equal(reviewedDirty.srs.totalReviews, 1);
  assert.equal(isItemDirty(reviewedDirty), true, 'the offline edit still has to be pushed');
  assert.equal(reviewedDirty.lastSyncedHash, dirty.lastSyncedHash);
  assert.equal(same, untouched);
  assert.equal(prepared.cursor, cursor);
});

test('a queued review older than the stored schedule changes nothing', () => {
  const reviewedLater = synced(card('a', { srs: schedule('a', { lastReviewDate: 900, totalReviews: 2 }) }));
  const [kept] = prepareStoredLibrary({ items: [reviewedLater], cursor }, [review('a', 500)], NOW).items;
  assert.equal(kept, reviewedLater);
});
