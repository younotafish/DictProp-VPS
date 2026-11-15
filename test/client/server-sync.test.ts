import assert from 'node:assert/strict';
import test from 'node:test';
import { pullOrSnapshot, syncSnapshot } from '../../services/serverSync.ts';
import type { RevisionCursor, StoredItem } from '../../types.ts';

const item = (id: string): StoredItem => ({
  type: 'vocab',
  data: { id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});
const cursorAt = (revision: number): RevisionCursor => ({ revision, id: `item-${revision}` });

test('a stored cursor whose pull succeeds needs no snapshot', async () => {
  const pulled: RevisionCursor[] = [];
  let snapshots = 0;
  await pullOrSnapshot(cursorAt(7), async from => { pulled.push(from); return true; }, async () => { snapshots++; });
  assert.deepEqual(pulled, [cursorAt(7)]);
  assert.equal(snapshots, 0);
});

test('a server behind the stored cursor, or no cursor at all, takes a full snapshot', async () => {
  let snapshots = 0;
  await pullOrSnapshot(cursorAt(7), async () => false, async () => { snapshots++; });
  assert.equal(snapshots, 1, 'the server reports it is behind: its database was replaced');

  let pulls = 0;
  await pullOrSnapshot(null, async () => { pulls++; return true; }, async () => { snapshots++; });
  assert.equal(pulls, 0, 'without a cursor there is nothing to pull from');
  assert.equal(snapshots, 2);
});

test('a snapshot is merged and stored with its cursor', async () => {
  const merged: Array<{ ids: string[]; cursor: RevisionCursor }> = [];
  const stored: RevisionCursor[] = [];
  await syncSnapshot({
    loadAll: async () => ({ items: [item('a'), item('b')], cursor: cursorAt(9) }),
    mergeSnapshot: async (items, cursor) => { merged.push({ ids: items.map(entry => entry.data.id), cursor }); },
    storeCursor: cursor => { stored.push(cursor); },
  });
  assert.deepEqual(merged, [{ ids: ['a', 'b'], cursor: cursorAt(9) }]);
  assert.deepEqual(stored, []);
});

test('an empty snapshot keeps only its cursor, so a replaced, empty database never re-uploads the library', async () => {
  const stored: RevisionCursor[] = [];
  let merges = 0;
  await syncSnapshot({
    loadAll: async () => ({ items: [], cursor: cursorAt(0) }),
    mergeSnapshot: async () => { merges++; },
    storeCursor: cursor => { stored.push(cursor); },
  });
  assert.equal(merges, 0);
  assert.deepEqual(stored, [cursorAt(0)]);
});
