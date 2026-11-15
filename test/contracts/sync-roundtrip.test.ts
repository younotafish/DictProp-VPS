import assert from 'node:assert/strict';
import test from 'node:test';

// Progress that moves backwards (a reset, an undone review) has to survive the server's save and every
// device's merge, which otherwise keep the schedule with the newest review.
const { applyReviewEvent, getItemById, getItemsAfterRevision, undoReviewEvent, upsertItem, upsertMany } = await import('../../server/src/db.js');
const { applyServerSave, mergeDatasets, reconcileReviewedItem, trackServerContent } = await import('../../services/sync.ts');
const { isItemDirty } = await import('../../services/itemHash.ts');
const { SRSAlgorithm } = await import('../../services/srsAlgorithm.ts');
const { updateAfterRating } = await import('../../services/fsrsScheduler.ts');
import type { StoredItem } from '../../types.ts';

const USER = 'srs-sync-user';
const DAY = 86_400_000;
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

interface Device {
  items: StoredItem[];
  cursor: { revision: number; id: string };
}

const newDevice = (): Device => ({ items: [], cursor: { revision: 0, id: '' } });

function pull(device: Device): void {
  const page = getItemsAfterRevision(device.cursor, 500, USER);
  const remote = wire(page.items) as StoredItem[];
  if (remote.length > 0) device.items = trackServerContent(mergeDatasets(device.items, remote), remote);
  device.cursor = page.cursor;
}

function push(device: Device): number {
  const dirty = device.items.filter(isItemDirty);
  if (dirty.length === 0) return 0;
  const result = upsertMany(wire(dirty), USER);
  device.items = applyServerSave(device.items, dirty, {
    revisions: new Map(Object.entries(result.revisions)),
    canonical: new Map(),
  });
  return dirty.length;
}

const find = (items: readonly StoredItem[], id: string) => items.find(item => item.data.id === id)!;
const serverCopy = (id: string) => find(getItemsAfterRevision({ revision: 0, id: '' }, 500, USER).items, id);

function vocabItem(id: string, srs = SRSAlgorithm.createNew(id, 'vocab')): StoredItem {
  return {
    type: 'vocab', savedAt: 1, updatedAt: 1,
    data: {
      id, word: id, chinese: '', ipa: '', definition: `definition ${id}`,
      synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
    },
    srs,
  };
}

const reviewed = (id: string) =>
  vocabItem(id, updateAfterRating(SRSAlgorithm.createNew(id, 'vocab'), 'good', Date.now() - DAY));

test('a reset sticks through its push and the next pull', () => {
  upsertMany([reviewed('reset-me')], USER);
  const device = newDevice();
  pull(device);
  assert.equal(find(device.items, 'reset-me').srs.totalReviews, 1);

  device.items = device.items.map(item => item.data.id === 'reset-me'
    ? { ...item, srs: SRSAlgorithm.reset('reset-me', 'vocab'), updatedAt: Date.now() }
    : item);
  assert.equal(push(device), 1);
  pull(device);

  assert.equal(serverCopy('reset-me').srs.totalReviews, 0);
  assert.equal(find(device.items, 'reset-me').srs.totalReviews, 0);
  assert.equal(isItemDirty(find(device.items, 'reset-me')), false);
});

test('a device still holding the reviewed schedule takes the reset, even with an unsynced edit', () => {
  upsertMany([reviewed('reset-seen')], USER);
  const resetting = newDevice();
  const other = newDevice();
  pull(resetting);
  pull(other);

  other.items = other.items.map(item => item.data.id === 'reset-seen'
    ? { ...item, data: { ...item.data, definition: 'edited on the other device' }, updatedAt: Date.now() }
    : item);
  resetting.items = resetting.items.map(item => item.data.id === 'reset-seen'
    ? { ...item, srs: SRSAlgorithm.reset('reset-seen', 'vocab'), updatedAt: Date.now() }
    : item);
  push(resetting);
  pull(other);
  push(other);

  const merged = find(other.items, 'reset-seen');
  assert.equal(merged.srs.totalReviews, 0);
  assert.equal((merged.data as any).definition, 'edited on the other device');
  assert.equal(serverCopy('reset-seen').srs.totalReviews, 0);
  assert.equal((serverCopy('reset-seen').data as any).definition, 'edited on the other device');
});

test('an undo reaches a device that pulled the review before it', () => {
  upsertMany([vocabItem('undo-me')], USER);
  const other = newDevice();
  pull(other);

  const event = {
    id: 'undo-me-review', itemId: 'undo-me', itemType: 'vocab' as const, reviewedAt: Date.now(),
    previousStep: 0, nextStep: 1, rating: 'good' as const, taskType: 'quick' as const,
  };
  assert.ok(applyReviewEvent(event, ['undo-me'], USER));
  pull(other);
  assert.equal(find(other.items, 'undo-me').srs.totalReviews, 1);

  assert.equal(undoReviewEvent('undo-me-review', USER)?.undone, true);
  pull(other);

  assert.equal(find(other.items, 'undo-me').srs.totalReviews, 0);
  assert.equal(push(other), 0);
  assert.equal(serverCopy('undo-me').srs.totalReviews, 0);
});

// A vocab card with independent content and review clocks, as the round trips below store it.
const makeItem = (
  id: string,
  definition: string,
  updatedAt: number,
  lastReviewDate: number,
  totalReviews: number,
) => ({
  type: 'vocab',
  data: {
    id,
    word: 'test',
    definition,
    chinese: '',
    ipa: '',
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
    type: 'vocab',
    nextReview: lastReviewDate + 86_400_000,
    interval: 1440,
    memoryStrength: 10,
    lastReviewDate,
    lastExposureDate: 0,
    totalReviews,
    correctStreak: totalReviews,
    stability: 1,
  },
  savedAt: 1,
  updatedAt,
});

test('a cleared flag or an image URL survives a server round trip without re-dirtying the item', () => {
  const userId = 'echo-user';
  for (const [id, change] of [
    ['echo-undeleted', { isDeleted: false }],
    ['echo-unarchived', { isArchived: false }],
    ['echo-image-url', { data: { ...makeItem('echo-image-url', 'with url', 1, 0, 0).data, imageUrl: 'https://example.com/a.png' } }],
  ] as const) {
    const saved = makeItem(id, 'with url', 1, 0, 0);
    const edited = { ...saved, ...change, updatedAt: 2 } as any;
    // Push, as pushNow does, then pull the server's copy back, as pullChanges does.
    const { revision } = upsertItem(structuredClone(edited), userId);
    const [pushed] = applyServerSave([edited], [edited], { revisions: new Map([[id, revision]]), canonical: new Map() });
    assert.equal(isItemDirty(pushed), false, id);
    const echo = getItemsAfterRevision({ revision: revision - 1, id: '' }, 500, userId).items.filter(item => item.data.id === id);
    const [pulled] = trackServerContent(mergeDatasets([pushed], echo), echo);
    assert.equal(isItemDirty(pulled), false, id);
  }
});

test('a reviewed item keeps its unsynced edits only while the server changed nothing else', () => {
  const userId = 'reconcile-user';
  const pull = (id: string) => {
    const items = wire(getItemsAfterRevision({ revision: 0, id: '' }, 500, userId).items.filter(item => item.data.id === id));
    return trackServerContent(mergeDatasets([], items), items)[0];
  };
  const edit = (item: any) => ({ ...item, updatedAt: 2, data: { ...item.data, mnemonic: 'my note' } });
  const review = (id: string, eventId: string) => applyReviewEvent(
    { id: eventId, itemId: id, itemType: 'vocab', reviewedAt: Date.now(), previousStep: 0, nextStep: 1, rating: 'good' },
    [id],
    userId,
  )!;

  // Only the review changed the server copy: the edit survives it, still dirty, and its push is accepted.
  upsertItem(makeItem('reconcile-quiet', 'plain', 1, 0, 0), userId);
  let local = edit(pull('reconcile-quiet'));
  const applied = review('reconcile-quiet', 'reconcile-quiet-review');
  let reconciled: any = reconcileReviewedItem(local, wire(applied.items[0]), applied.baseRevisions['reconcile-quiet']);
  assert.equal(reconciled.data.mnemonic, 'my note');
  assert.equal(reconciled.srs.totalReviews, 1);
  assert.equal(isItemDirty(reconciled), true);
  // A retried review reports the same base while it is still the item's latest change, and none after.
  assert.deepEqual(review('reconcile-quiet', 'reconcile-quiet-review').baseRevisions, applied.baseRevisions);
  assert.equal(upsertItem(wire(reconciled), userId).conflicted, false);
  assert.equal(getItemById('reconcile-quiet', userId)?.data.mnemonic, 'my note');
  assert.deepEqual(review('reconcile-quiet', 'reconcile-quiet-review').baseRevisions, {});

  // Another writer changed the server copy first: the review hands over its copy, as a pull would, instead of
  // letting the next push overwrite it.
  upsertItem(makeItem('reconcile-enriched', 'plain', 1, 0, 0), userId);
  local = edit(pull('reconcile-enriched'));
  upsertItem({ ...makeItem('reconcile-enriched', 'enriched', 3, 0, 0), serverRevision: local.serverRevision }, userId);
  const raced = review('reconcile-enriched', 'reconcile-enriched-review');
  reconciled = reconcileReviewedItem(local, wire(raced.items[0]), raced.baseRevisions['reconcile-enriched']);
  assert.equal(reconciled.data.definition, 'enriched');
  assert.equal(reconciled.srs.totalReviews, 1);
  assert.equal(isItemDirty(reconciled), false);

  // An undo reports its base the same way.
  upsertItem(makeItem('reconcile-undo', 'plain', 1, 0, 0), userId);
  review('reconcile-undo', 'reconcile-undo-review');
  local = edit(pull('reconcile-undo'));
  const undone = undoReviewEvent('reconcile-undo-review', userId)!;
  reconciled = reconcileReviewedItem(local, wire(undone.items[0]), undone.baseRevisions['reconcile-undo']);
  assert.equal(reconciled.data.mnemonic, 'my note');
  assert.equal(reconciled.srs.totalReviews, 0);
  assert.equal(isItemDirty(reconciled), true);
});
