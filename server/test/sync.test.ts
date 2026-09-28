import assert from 'node:assert/strict';
import test from 'node:test';
import { getItemContentHash, isItemDirty } from '../../services/itemHash.ts';
import { applyServerSave, mergeDatasets, trackServerContent } from '../../services/sync.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

function vocab(id: string, imageUrl?: string): VocabCard {
  return {
    id,
    word: id,
    chinese: '',
    ipa: '',
    definition: `definition ${id}`,
    synonyms: [],
    antonyms: [],
    confusables: [],
    examples: [],
    history: '',
    register: '',
    mnemonic: '',
    imageUrl,
  };
}

function phrase(vocabs: VocabCard[], updatedAt: number): StoredItem {
  return {
    type: 'phrase',
    data: {
      id: 'phrase', query: 'query', translation: '', grammar: '', visualKeyword: '',
      pronunciation: '', timestamp: 1, vocabs,
    },
    savedAt: 1,
    updatedAt,
    srs: {
      id: 'phrase', type: 'phrase', nextReview: 0, interval: 0, memoryStrength: 0,
      lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5,
    },
  };
}

test('phrase image merge follows vocab ids after reordering', () => {
  const local = phrase([vocab('alpha', 'idb:alpha'), vocab('beta', 'idb:beta')], 1);
  const remote = phrase([vocab('beta', 'server:beta'), vocab('alpha', 'server:alpha')], 2);

  const merged = mergeDatasets([local], [remote])[0].data as any;
  assert.equal(merged.vocabs[0].id, 'beta');
  assert.equal(merged.vocabs[0].imageUrl, 'idb:beta');
  assert.equal(merged.vocabs[1].id, 'alpha');
  assert.equal(merged.vocabs[1].imageUrl, 'idb:alpha');
});

test('newer versioned server markers invalidate local image caches by vocab id', () => {
  const local = phrase([vocab('alpha', 'idb:stored'), vocab('beta', 'idb:stored')], 1);
  const remote = phrase([
    vocab('beta', 'server:has_image:bbbbbbbbbbbbbbbbbbbb'),
    vocab('alpha', 'server:has_image:aaaaaaaaaaaaaaaaaaaa'),
  ], 2);

  const merged = mergeDatasets([local], [remote])[0].data as any;
  assert.equal(merged.vocabs[0].imageUrl, 'server:has_image:bbbbbbbbbbbbbbbbbbbb');
  assert.equal(merged.vocabs[1].imageUrl, 'server:has_image:aaaaaaaaaaaaaaaaaaaa');
});

test('newer versioned server marker invalidates a saved top-level image', () => {
  const local = { ...phrase([], 9_999_999), serverRevision: 4 };
  const remote = { ...phrase([], 2), serverRevision: 5 };
  (local.data as any).imageUrl = 'idb:stored';
  (remote.data as any).imageUrl = 'server:has_image:cccccccccccccccccccc';
  const merged = mergeDatasets([local], [remote])[0].data as any;
  assert.equal(merged.imageUrl, 'server:has_image:cccccccccccccccccccc');
});

test('legacy project metadata no longer affects content identity', () => {
  const item = phrase([], 1);
  const moved = { ...item, project: 'project-b' };
  assert.equal(getItemContentHash(item), getItemContentHash(moved));
});

test('newer complete sentence content is not mistaken for a lightweight cache entry', () => {
  const base = phrase([], 1);
  const remote: StoredItem = {
    ...base,
    type: 'sentence',
    data: { id: 'sentence', text: 'old sentence', sourceWord: 'old' },
    srs: { ...base.srs, id: 'sentence', type: 'sentence' },
    updatedAt: 1,
  };
  const local: StoredItem = {
    ...remote,
    data: { id: 'sentence', text: 'new sentence', sourceWord: 'new' },
    updatedAt: 2,
  };

  const merged = mergeDatasets([local], [remote])[0];
  assert.equal((merged.data as any).text, 'new sentence');
});

test('server revision outranks a skewed device timestamp', () => {
  const local = { ...phrase([], 9_999_999), serverRevision: 4 };
  const remote = { ...phrase([], 1), serverRevision: 5 };
  (local.data as any).translation = 'stale local edit';
  (remote.data as any).translation = 'server revision wins';
  const merged = mergeDatasets([local], [remote])[0];
  assert.equal((merged.data as any).translation, 'server revision wins');
  assert.equal(merged.serverRevision, 5);
});

test('passive exposure recency merges independently from explicit review progress', () => {
  const local = phrase([], 2);
  local.srs = {
    ...local.srs,
    lastReviewDate: 20,
    totalReviews: 2,
    lastExposureDate: 30,
  };
  const remote = phrase([], 3);
  remote.srs = {
    ...remote.srs,
    lastReviewDate: 10,
    totalReviews: 1,
    lastExposureDate: 40,
  };

  const merged = mergeDatasets([local], [remote])[0];
  assert.equal(merged.srs.lastReviewDate, 20);
  assert.equal(merged.srs.totalReviews, 2);
  assert.equal(merged.srs.lastExposureDate, 40);
});

test('passive exposure changes the dirty-sync hash', () => {
  const before = phrase([], 1);
  const after = {
    ...before,
    srs: { ...before.srs, lastExposureDate: 123 },
  };
  assert.notEqual(getItemContentHash(before), getItemContentHash(after));
});

test('legacy passive strength is removed when an unreviewed sentence returns from the server', () => {
  const base = phrase([], 1);
  const local: StoredItem = {
    ...base,
    type: 'sentence',
    data: { id: 'legacy-exposure', text: 'Still unreviewed.', sourceWord: '' },
    srs: { ...base.srs, id: 'legacy-exposure', type: 'sentence', memoryStrength: 0, stability: 0.5 },
  };
  const remote: StoredItem = {
    ...local,
    updatedAt: 2,
    srs: { ...local.srs, memoryStrength: 38, stability: 7 },
  };

  const merged = mergeDatasets([local], [remote])[0];
  assert.equal(merged.srs.totalReviews, 0);
  assert.equal(merged.srs.memoryStrength, 0);
  assert.equal(merged.srs.stability, 0.5);
});

test('equal revisions keep unsynced local edits over the server echo', () => {
  const local = { ...phrase([], 1), serverRevision: 5 };
  const remote = { ...phrase([], 9), serverRevision: 5 };
  (local.data as any).translation = 'edited after the push';
  (remote.data as any).translation = 'echo of the push';
  const merged = mergeDatasets([local], [remote])[0];
  assert.equal((merged.data as any).translation, 'edited after the push');
});

test('a merge that changes nothing returns the local object', () => {
  const local = { ...phrase([], 1), serverRevision: 3, lastSyncedHash: 'synced' };
  const remote = structuredClone({ ...local, lastSyncedHash: undefined });
  assert.equal(mergeDatasets([local], [remote])[0], local);
});

test('server content tracking marks items clean or dirty against the server copy', () => {
  const matching = { ...phrase([], 1), serverRevision: 2 };
  const localOnly: StoredItem = { ...phrase([], 1), data: { ...phrase([], 1).data, id: 'local-only' } };
  const items = [matching, localOnly];

  const tracked = trackServerContent(items, [structuredClone(matching)]);
  assert.equal(isItemDirty(tracked[0]), false);
  assert.equal(tracked[1], localOnly);
  assert.equal(trackServerContent(tracked, [structuredClone(matching)]), tracked);

  // A complete snapshot also marks what the server lacks as dirty.
  const complete = trackServerContent([...tracked, { ...localOnly, lastSyncedHash: 'stale' }], [matching], { complete: true });
  assert.equal(complete[2].lastSyncedHash, undefined);
  assert.equal(isItemDirty(complete[2]), true);
});

test('server content tracking ignores a copy older than the item', () => {
  const item = { ...phrase([], 1), serverRevision: 7, lastSyncedHash: 'from-review' };
  const olderCopy = { ...phrase([], 1), serverRevision: 6 };
  const items = [item];
  assert.equal(trackServerContent(items, [olderCopy]), items);
});

test('a push acknowledgement marks the sent copy clean and keeps later edits dirty', () => {
  const sent = { ...phrase([], 1), serverRevision: 4 };
  const editedMeanwhile = { ...sent, updatedAt: 2, data: { ...sent.data, translation: 'edited later' } };
  const result = { revisions: new Map([['phrase', 5]]), canonical: new Map<string, StoredItem>() };

  const [clean] = applyServerSave([sent], [sent], result);
  assert.equal(clean.serverRevision, 5);
  assert.equal(isItemDirty(clean), false);

  const [dirty] = applyServerSave([editedMeanwhile], [sent], result);
  assert.equal(dirty.serverRevision, 5);
  assert.equal((dirty.data as any).translation, 'edited later');
  assert.equal(isItemDirty(dirty), true);
});

test('a push acknowledgement adopts the copy the server kept', () => {
  const sent = { ...phrase([], 1), serverRevision: 3 };
  (sent.data as any).translation = 'stale edit';
  const kept = { ...phrase([], 1), serverRevision: 6 };
  (kept.data as any).translation = 'server copy';
  const result = { revisions: new Map<string, number>(), canonical: new Map([['phrase', kept]]) };

  const [adopted] = applyServerSave([sent], [sent], result);
  assert.equal((adopted.data as any).translation, 'server copy');
  assert.equal(adopted.serverRevision, 6);
  assert.equal(isItemDirty(adopted), false);
});

test('an outdated push acknowledgement changes nothing', () => {
  const sent = { ...phrase([], 1), serverRevision: 4 };
  // A review response recorded revision 7 while the push was in flight.
  const reviewed = { ...sent, serverRevision: 7, lastSyncedHash: 'from-review' };
  const items = [reviewed];
  const stale = { revisions: new Map([['phrase', 5]]), canonical: new Map<string, StoredItem>() };
  assert.equal(applyServerSave(items, [sent], stale), items);

  const recorded = { ...sent, serverRevision: 5, lastSyncedHash: getItemContentHash(sent) };
  const repeated = [recorded];
  assert.equal(applyServerSave(repeated, [sent], stale), repeated);
});
