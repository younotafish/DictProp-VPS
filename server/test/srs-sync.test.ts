import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-srs-sync-test-'));

// Progress that moves backwards (a reset, an undone review) has to survive the server's save and every
// device's merge, which otherwise keep the schedule with the newest review.
const { applyReviewEvent, getItemsAfterRevision, undoReviewEvent, upsertMany } = await import('../src/db.js');
const { applyServerSave, mergeDatasets, trackServerContent } = await import('../../services/sync.ts');
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
