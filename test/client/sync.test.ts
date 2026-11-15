import assert from 'node:assert/strict';
import test from 'node:test';
import { getItemContentHash, isItemDirty } from '../../services/itemHash.ts';
import { applyServerSave, dropExpiredTombstones, mergeDatasets, trackServerContent } from '../../services/sync.ts';
import type { SaveItemsResult } from '../../services/api.ts';
import { saveOverExisting } from '../../services/items.ts';
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

function srs(id: string, totalReviews: number, lastReviewDate: number): StoredItem['srs'] {
  return {
    id, type: 'vocab', nextReview: lastReviewDate, interval: 0, memoryStrength: 0,
    lastReviewDate, totalReviews, correctStreak: 0, stability: 0.5,
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

test('a revision bump that kept the synced content rebases unsynced local edits', () => {
  const synced = { ...phrase([vocab('alpha', 'idb:stored')], 1), serverRevision: 4 };
  const local: StoredItem = {
    ...synced,
    updatedAt: 2,
    data: { ...synced.data, translation: 'unsynced edit' },
    lastSyncedHash: getItemContentHash(synced),
  };
  // An image upload bumped the revision and versioned the marker, but the content is as synced.
  const bumped: StoredItem = {
    ...structuredClone(synced),
    serverRevision: 9,
    data: { ...structuredClone(synced.data), vocabs: [vocab('alpha', 'server:has_image:aaaaaaaaaaaaaaaaaaaa')] },
  };
  const merged = mergeDatasets([local], [bumped])[0];
  assert.equal((merged.data as any).translation, 'unsynced edit');
  assert.equal((merged.data as any).vocabs[0].imageUrl, 'server:has_image:aaaaaaaaaaaaaaaaaaaa');
  assert.equal(merged.serverRevision, 9);
  assert.equal(isItemDirty(merged), true);

  // Content this device never synced still wins by revision.
  const edited: StoredItem = { ...bumped, data: { ...bumped.data, translation: 'server edit' } };
  assert.equal((mergeDatasets([local], [edited])[0].data as any).translation, 'server edit');
});

test('a review on another device rebases unsynced local edits and brings its schedule', () => {
  const synced: StoredItem = { type: 'vocab', data: vocab('w'), savedAt: 1, updatedAt: 1, serverRevision: 4, srs: srs('w', 0, 0) };
  const local: StoredItem = {
    ...synced,
    updatedAt: 2,
    data: { ...synced.data, definition: 'unsynced edit' },
    lastSyncedHash: getItemContentHash(synced),
  };
  // Another device reviewed the card: the schedule and revision changed, the content didn't.
  const reviewed: StoredItem = { ...structuredClone(synced), serverRevision: 5, srs: srs('w', 1, 5_000) };
  const merged = mergeDatasets([local], [reviewed])[0];
  assert.equal((merged.data as VocabCard).definition, 'unsynced edit');
  assert.equal(merged.srs.totalReviews, 1);
  assert.equal(merged.serverRevision, 5);
  assert.equal(isItemDirty(merged), true);

  // A content change there as well still wins by revision.
  const edited: StoredItem = { ...reviewed, data: { ...reviewed.data, definition: 'server edit' } };
  assert.equal((mergeDatasets([local], [edited])[0].data as VocabCard).definition, 'server edit');
});

for (const flag of ['isDeleted', 'isArchived'] as const) {
  test(`${flag} set offline survives a server rewrite that left the flag alone`, () => {
    const synced: StoredItem = { type: 'vocab', data: vocab('x'), savedAt: 1, updatedAt: 1, serverRevision: 10, srs: srs('x', 0, 0) };
    const local: StoredItem = { ...synced, [flag]: true, updatedAt: 2, lastSyncedHash: getItemContentHash(synced) };
    // The enrichment cycle rewrote the card on the server meanwhile.
    const enriched: StoredItem = { ...structuredClone(synced), serverRevision: 11, data: { ...vocab('x'), definition: 'enriched' } };
    const merged = trackServerContent(mergeDatasets([local], [enriched]), [enriched])[0];
    assert.equal(merged[flag], true);
    assert.equal((merged.data as VocabCard).definition, 'enriched');
    assert.equal(merged.serverRevision, 11);
    assert.equal(isItemDirty(merged), true, 'the flag still has to reach the server');

    // A flag the server changed is the server's call, even over unsynced edits here.
    const edited: StoredItem = { ...synced, data: { ...vocab('x'), definition: 'mine' }, updatedAt: 2, lastSyncedHash: getItemContentHash(synced) };
    assert.equal(mergeDatasets([edited], [{ ...enriched, [flag]: true }])[0][flag], true);
  });
}

test('an unsynced deletion survives a revision bump that kept the synced content', () => {
  const synced = { ...phrase([], 1), serverRevision: 4 };
  const deleted: StoredItem = { ...synced, isDeleted: true, updatedAt: 2, lastSyncedHash: getItemContentHash(synced) };
  const merged = mergeDatasets([deleted], [{ ...structuredClone(synced), serverRevision: 9 }])[0];
  assert.equal(merged.isDeleted, true);
  assert.equal(merged.serverRevision, 9);
});

test('expired tombstones drop unless their deletion is unsynced', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  const tombstone = (id: string, updatedAt: number, synced: boolean): StoredItem => {
    const item: StoredItem = { ...phrase([], updatedAt), data: { ...phrase([], 1).data, id }, isDeleted: true };
    return synced ? { ...item, lastSyncedHash: getItemContentHash(item) } : item;
  };
  const live = phrase([], 1);
  const recent = tombstone('recent', now - day, true);
  const { items, droppedIds } = dropExpiredTombstones([
    live, recent, tombstone('expired', now - 31 * day, true), tombstone('unsynced', now - 31 * day, false),
  ], now);
  assert.deepEqual(droppedIds, ['expired']);
  assert.deepEqual(items.map(item => item.data.id), ['phrase', 'recent', 'unsynced']);

  const unexpired = [live, recent];
  assert.equal(dropExpiredTombstones(unexpired, now).items, unexpired);
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

test('an edit saved from a copy older than the saved one never overwrites newer server content', () => {
  const opened: StoredItem = { type: 'vocab', data: vocab('x'), savedAt: 1, updatedAt: 1, serverRevision: 10, srs: srs('x', 0, 0) };
  opened.lastSyncedHash = getItemContentHash(opened);
  const conflict = (canonical: StoredItem): SaveItemsResult => ({ revisions: new Map(), canonical: new Map([['x', canonical]]) });

  // The enrichment cycle rewrote the card while a view still held the copy it opened with.
  const enriched: StoredItem = { ...opened, serverRevision: 11, data: { ...vocab('x'), definition: 'enriched' } };
  const saved: StoredItem = { ...enriched, lastSyncedHash: getItemContentHash(enriched) };
  const edit: StoredItem = { ...opened, data: { ...opened.data, mnemonic: 'mine' } };
  const staleSave = saveOverExisting(saved, edit, 2);
  assert.equal(isItemDirty(staleSave), true);
  const [afterPush] = applyServerSave([staleSave], [staleSave], conflict(enriched));
  assert.equal((afterPush.data as VocabCard).definition, 'enriched');
  assert.equal(afterPush.serverRevision, 11);
  assert.equal(isItemDirty(afterPush), false);

  // A revision that left the content alone (an image upload, say) takes the edit on top.
  const imaged: StoredItem = { ...opened, serverRevision: 11 };
  const [rebased] = applyServerSave([saveOverExisting({ ...imaged, lastSyncedHash: opened.lastSyncedHash }, edit, 2)], [staleSave], conflict(imaged));
  assert.equal((rebased.data as VocabCard).mnemonic, 'mine');
  assert.equal(rebased.serverRevision, 11);
  assert.equal(isItemDirty(rebased), true);

  // A current copy builds on the saved one's sync record as before.
  const current = saveOverExisting(saved, { ...saved, data: { ...saved.data, mnemonic: 'mine' } }, 2);
  assert.equal(current.lastSyncedHash, saved.lastSyncedHash);
  assert.equal(current.serverRevision, 11);
});

test('saving a deleted card again brings back its learning history, not its archive', () => {
  const reviewed = srs('x', 7, 100);
  const deleted: StoredItem = { type: 'vocab', data: vocab('x'), savedAt: 1, updatedAt: 5, srs: reviewed, isDeleted: true, isArchived: true };
  const resaved = saveOverExisting(deleted, { type: 'vocab', data: vocab('x'), savedAt: 9, srs: srs('x', 0, 0) }, 9);
  assert.equal(resaved.srs.totalReviews, 7);
  assert.equal(resaved.srs.lastReviewDate, 100);
  assert.equal(resaved.isDeleted, undefined);
  assert.equal(resaved.isArchived, undefined);
  assert.equal(resaved.savedAt, 1);

  // A live card keeps the schedule the save carries, as before.
  const live = saveOverExisting({ ...deleted, isDeleted: undefined }, { ...deleted, isDeleted: undefined, srs: srs('x', 8, 200) }, 9);
  assert.equal(live.srs.totalReviews, 8);
});

test('a pull at the same revision brings the server-owned fields a save here left out', () => {
  const audit = { status: 'current_general', reason: 'common' };
  const enrichment = { examplesHash: 'abc' };
  // Saved here from a fresh AI result: the vocab has no audit, and the phrase's second vocab no enrichment.
  const pushed: StoredItem = { ...phrase([vocab('alpha'), vocab('beta')], 1), serverRevision: 5 };
  const local: StoredItem = { ...pushed, lastSyncedHash: getItemContentHash(pushed) };
  // The server kept them, at the same revision (a save that only left them out changes nothing there).
  const server: StoredItem = structuredClone(pushed);
  Object.assign((server.data as any), { usageAudit: audit });
  Object.assign((server.data as any).vocabs[1], { advancedEnrichment: enrichment });

  const merged = trackServerContent(mergeDatasets([local], [server]), [server])[0];
  assert.deepEqual((merged.data as any).usageAudit, audit);
  assert.deepEqual((merged.data as any).vocabs[1].advancedEnrichment, enrichment);
  assert.equal(isItemDirty(merged), false, 'the item matches its server copy, so nothing is pushed again');

  // Edits made here since are kept, on top of the fields.
  const edited: StoredItem = { ...local, data: { ...local.data, translation: 'unsynced edit' } };
  const mergedEdit = trackServerContent(mergeDatasets([edited], [server]), [server])[0];
  assert.equal((mergedEdit.data as any).translation, 'unsynced edit');
  assert.deepEqual((mergedEdit.data as any).usageAudit, audit);
  assert.equal(isItemDirty(mergedEdit), true);

  // A copy of an older revision doesn't speak for the server's current one.
  const newer: StoredItem = { ...local, serverRevision: 6 };
  assert.equal((mergeDatasets([newer], [server])[0].data as any).usageAudit, undefined);
});

test('a sentence takes the server analysis only for the text it analyzed', () => {
  const sentence = (text: string, revision: number): StoredItem => ({
    type: 'sentence',
    data: { id: 's1', text, sourceWord: 'word', createdAt: 1 } as any,
    savedAt: 1,
    updatedAt: 1,
    serverRevision: revision,
    srs: { ...srs('s1', 0, 0), type: 'sentence' },
  });
  const server = sentence('The same text.', 3);
  Object.assign(server.data as any, { analysis: { summary: 'x' }, analysisGeneratedAt: 7 });
  const same = sentence('The same text.', 3);
  assert.deepEqual((mergeDatasets([same], [server])[0].data as any).analysis, { summary: 'x' });
  const rewritten = sentence('Rewritten here.', 3);
  assert.equal((mergeDatasets([rewritten], [server])[0].data as any).analysis, undefined);
});

test('a synced copy takes the server schedule even when it moved back, and unsynced progress keeps its review', () => {
  const reviewed = { ...phrase([], 1), serverRevision: 4 };
  reviewed.srs = { ...reviewed.srs, lastReviewDate: 20, totalReviews: 1 };
  const synced = { ...reviewed, lastSyncedHash: getItemContentHash(reviewed) };
  // Another device undid the review.
  const undone = { ...phrase([], 1), serverRevision: 5 };

  const merged = mergeDatasets([synced], [undone])[0];
  assert.equal(merged.srs.totalReviews, 0);
  assert.equal(merged.srs.lastReviewDate, 0);

  const reviewedAgain = { ...synced, srs: { ...synced.srs, lastReviewDate: 30, totalReviews: 2 } };
  assert.equal(mergeDatasets([reviewedAgain], [undone])[0].srs.totalReviews, 2);
});
