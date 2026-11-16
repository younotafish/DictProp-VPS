import assert from 'node:assert/strict';
import test from 'node:test';

// Progress that moves backwards (a reset, an undone review) has to survive the server's save and every
// device's merge, which otherwise keep the schedule with the newest review.
const { applyReviewEvent, getItemById, getItemsAfterRevision, undoReviewEvent, upsertItem, upsertMany } = await import('../../server/src/db.js');
const { applyServerSave, mergeDatasets, reconcileReviewedItem, trackServerContent } = await import('../../services/sync.ts');
const { isItemDirty } = await import('../../services/itemHash.ts');
const { SRSAlgorithm } = await import('../../services/srsAlgorithm.ts');
const { updateAfterRating } = await import('../../services/fsrsScheduler.ts');
import type { StoredItemRecord } from '../../server/src/db.js';
import type { StoredItem, VocabCard } from '../../types.ts';

const USER = 'srs-sync-user';
const DAY = 86_400_000;
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
/** Server items as a device receives them: through the JSON the routes send, read as the client's StoredItem. */
const asClientItems = (items: readonly StoredItemRecord[]): StoredItem[] => JSON.parse(JSON.stringify(items));
const asClientItem = (item: StoredItemRecord): StoredItem => JSON.parse(JSON.stringify(item));

interface Device {
  items: StoredItem[];
  cursor: { revision: number; id: string };
}

const newDevice = (): Device => ({ items: [], cursor: { revision: 0, id: '' } });

function pull(device: Device): void {
  const page = getItemsAfterRevision(device.cursor, 500, USER);
  const remote = asClientItems(page.items);
  if (remote.length > 0) device.items = trackServerContent(mergeDatasets(device.items, remote), remote);
  device.cursor = page.cursor;
}

function push(device: Device): number {
  const dirty = device.items.filter(isItemDirty);
  if (dirty.length === 0) return 0;
  const result = wire(upsertMany(wire(dirty), USER));
  device.items = applyServerSave(device.items, dirty, {
    revisions: new Map(Object.entries(result.revisions)),
    canonical: new Map(),
    kept: new Map(Object.entries(result.kept)),
  });
  return dirty.length;
}

const find = (items: readonly StoredItem[], id: string) => items.find(item => item.data.id === id)!;
const vocabData = (item: StoredItem) => item.data as VocabCard;
const serverCopy = (id: string) => find(asClientItems(getItemsAfterRevision({ revision: 0, id: '' }, 500, USER).items), id);

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
  assert.equal(vocabData(merged).definition, 'edited on the other device');
  assert.equal(serverCopy('reset-seen').srs.totalReviews, 0);
  assert.equal(vocabData(serverCopy('reset-seen')).definition, 'edited on the other device');
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

test('a card refreshed without the fields only server jobs write holds them once its push returns, before any pull', () => {
  const audit = { status: 'current_general', reason: 'Normal in current American English.', confidence: 'high', auditedAt: 1 };
  const marker = { version: 1, provider: 'claude-code', model: 'test-model', generatedAt: 2, contentHash: 'a'.repeat(64) };
  const card = vocabItem('refreshed');
  upsertMany([{ ...card, data: { ...card.data, usageAudit: audit, advancedEnrichment: marker } }], USER);
  const device = newDevice();
  pull(device);

  // Refreshing replaces the card's content with a fresh result, which has neither field.
  device.items = device.items.map(item => item.data.id === 'refreshed'
    ? { ...item, data: { ...card.data, definition: 'refreshed definition' }, updatedAt: Date.now() }
    : item);
  assert.equal(push(device), 1);
  const saved = find(device.items, 'refreshed');
  const data = saved.data as VocabCard;
  assert.equal(data.definition, 'refreshed definition');
  assert.deepEqual(data.usageAudit, audit);
  assert.deepEqual(data.advancedEnrichment, marker);
  assert.equal(saved.serverRevision, serverCopy('refreshed').serverRevision);
  assert.equal(isItemDirty(saved), false);

  // The next pull brings the push's own revision back and changes nothing.
  pull(device);
  assert.equal(find(device.items, 'refreshed'), saved);
  assert.equal(push(device), 0);
});

test('a save that only left out those fields, which the server keeps at the same revision, gets them back all the same', () => {
  const audit = { status: 'modern_american', reason: 'Common in the US.', confidence: 'high', auditedAt: 1 };
  const card = vocabItem('only-left-out');
  upsertMany([{ ...card, data: { ...card.data, usageAudit: audit } }], USER);
  const device = newDevice();
  pull(device);
  const revision = serverCopy('only-left-out').serverRevision;

  // The same content without the audit: the server has nothing to change, so no pull would ever bring the audit back.
  device.items = device.items.map(item => item.data.id === 'only-left-out' ? { ...item, data: card.data } : item);
  assert.equal(push(device), 1);
  assert.equal(serverCopy('only-left-out').serverRevision, revision);
  const saved = find(device.items, 'only-left-out');
  assert.deepEqual((saved.data as VocabCard).usageAudit, audit);
  assert.equal(isItemDirty(saved), false);
  assert.equal(push(device), 0);
  pull(device);
  assert.equal(find(device.items, 'only-left-out'), saved);
});

// A vocab card with independent content and review clocks, as the round trips below store it.
const makeItem = (
  id: string,
  definition: string,
  updatedAt: number,
  lastReviewDate: number,
  totalReviews: number,
): StoredItem => ({
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
    const edited: StoredItem = { ...saved, ...change, updatedAt: 2 };
    // Push, as pushNow does, then pull the server's copy back, as pullChanges does.
    const { revision } = upsertItem(structuredClone(edited), userId);
    const [pushed] = applyServerSave([edited], [edited], { revisions: new Map([[id, revision]]), canonical: new Map() });
    assert.equal(isItemDirty(pushed), false, id);
    const echo = asClientItems(getItemsAfterRevision({ revision: revision - 1, id: '' }, 500, userId).items.filter(item => item.data.id === id));
    const [pulled] = trackServerContent(mergeDatasets([pushed], echo), echo);
    assert.equal(isItemDirty(pulled), false, id);
  }
});

test('a reviewed item keeps its unsynced edits only while the server changed nothing else', () => {
  const userId = 'reconcile-user';
  const pull = (id: string) => {
    const items = asClientItems(getItemsAfterRevision({ revision: 0, id: '' }, 500, userId).items.filter(item => item.data.id === id));
    return trackServerContent(mergeDatasets([], items), items)[0];
  };
  const edit = (item: StoredItem): StoredItem => ({ ...item, updatedAt: 2, data: { ...item.data, mnemonic: 'my note' } });
  const review = (id: string, eventId: string) => applyReviewEvent(
    { id: eventId, itemId: id, itemType: 'vocab', reviewedAt: Date.now(), previousStep: 0, nextStep: 1, rating: 'good' },
    [id],
    userId,
  )!;

  // Only the review changed the server copy: the edit survives it, still dirty, and its push is accepted.
  upsertItem(makeItem('reconcile-quiet', 'plain', 1, 0, 0), userId);
  let local = edit(pull('reconcile-quiet'));
  const applied = review('reconcile-quiet', 'reconcile-quiet-review');
  let reconciled = reconcileReviewedItem(local, asClientItem(applied.items[0]), applied.baseRevisions['reconcile-quiet']);
  assert.equal(vocabData(reconciled).mnemonic, 'my note');
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
  reconciled = reconcileReviewedItem(local, asClientItem(raced.items[0]), raced.baseRevisions['reconcile-enriched']);
  assert.equal(vocabData(reconciled).definition, 'enriched');
  assert.equal(reconciled.srs.totalReviews, 1);
  assert.equal(isItemDirty(reconciled), false);

  // An undo reports its base the same way.
  upsertItem(makeItem('reconcile-undo', 'plain', 1, 0, 0), userId);
  review('reconcile-undo', 'reconcile-undo-review');
  local = edit(pull('reconcile-undo'));
  const undone = undoReviewEvent('reconcile-undo-review', userId)!;
  reconciled = reconcileReviewedItem(local, asClientItem(undone.items[0]), undone.baseRevisions['reconcile-undo']);
  assert.equal(vocabData(reconciled).mnemonic, 'my note');
  assert.equal(reconciled.srs.totalReviews, 0);
  assert.equal(isItemDirty(reconciled), true);
});
