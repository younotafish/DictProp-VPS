import assert from 'node:assert/strict';
import test from 'node:test';
import { getItemContentHash, isItemDirty } from '../../services/itemHash.ts';
import { mergeDatasets } from '../../services/sync.ts';
import type { SearchResult, SentenceData, SRSData, StoredItem, VocabCard } from '../../types.ts';

// Characterization of the per-pair merge: what one local copy and one server copy of the same item merge to.
// Every branch is pinned here so the merge can be restructured without changing a result.

// SRSAlgorithm.createNew stamps nextReview with the clock, so the clock stands still for these tests.
const realNow = Date.now;
Date.now = () => 1_700_000_000_000;
test.after(() => { Date.now = realNow; });

const merge = (local: StoredItem, remote: StoredItem): StoredItem => mergeDatasets([local], [remote])[0];

const schedule = (id: string, type: StoredItem['type'], fields: Partial<SRSData> = {}): SRSData => ({
  id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0,
  stability: 0.5, ...fields,
});

const card = (id: string, fields: Partial<VocabCard> = {}): VocabCard => ({
  id, word: id, chinese: '', ipa: '', definition: `definition ${id}`, synonyms: [], antonyms: [], confusables: [],
  examples: [], history: '', register: '', mnemonic: '', ...fields,
});

const vocab = (fields: Partial<StoredItem> = {}, data: Partial<VocabCard> = {}): StoredItem => ({
  type: 'vocab', data: card('w', data), savedAt: 1, srs: schedule('w', 'vocab'), ...fields,
});

const phraseData = (fields: Partial<SearchResult> = {}): SearchResult => ({
  id: 'p', query: 'query', translation: '', grammar: '', visualKeyword: '', pronunciation: '', timestamp: 1,
  vocabs: [], ...fields,
});

const phrase = (fields: Partial<StoredItem> = {}, data: Partial<SearchResult> = {}): StoredItem => ({
  type: 'phrase', data: phraseData(data), savedAt: 1, srs: schedule('p', 'phrase'), ...fields,
});

const sentence = (fields: Partial<StoredItem> = {}, data: Partial<SentenceData> = {}): StoredItem => ({
  type: 'sentence', data: { id: 's', text: 'A sentence.', sourceWord: 'word', ...data }, savedAt: 1,
  srs: schedule('s', 'sentence'), ...fields,
});

/** `item` as this device last synced it: clean until it changes. */
const synced = (item: StoredItem): StoredItem => ({ ...item, lastSyncedHash: getItemContentHash(item) });

const definitionOf = (item: StoredItem) => (item.data as VocabCard).definition;

// --- Deletions ---

test('a server deletion wins within the grace period when neither copy has a revision', () => {
  const local = vocab({ updatedAt: 14_000 }, { definition: 'local edit' });
  const remote = vocab({ updatedAt: 10_000, isDeleted: true });
  assert.equal(merge(local, remote), remote);
  // At the edge of the window it still wins.
  assert.equal(merge({ ...local, updatedAt: 15_000 }, remote), remote);
});

test('a local edit more than five seconds newer than a server deletion survives it, revisions aside', () => {
  const local = vocab({ updatedAt: 15_001 }, { definition: 'local edit' });
  const remote = vocab({ updatedAt: 10_000, isDeleted: true });
  const merged = merge(local, remote);
  assert.equal(merged.isDeleted, undefined);
  assert.equal(definitionOf(merged), 'local edit');
  assert.equal(merged.updatedAt, 15_001);
});

test('a server deletion at a newer revision wins over any timestamp, and loses to a newer local revision', () => {
  const local = vocab({ updatedAt: 99_999, serverRevision: 3 }, { definition: 'local edit' });
  const remote = vocab({ updatedAt: 1, serverRevision: 4, isDeleted: true });
  assert.equal(merge(local, remote), remote);

  const behind = { ...remote, serverRevision: 2 };
  const merged = merge(local, behind);
  assert.equal(merged.isDeleted, undefined);
  assert.equal(definitionOf(merged), 'local edit');
  assert.equal(merged.serverRevision, 3);
});

test('a local deletion wins within the grace period when neither copy has a revision', () => {
  const local = vocab({ updatedAt: 10_000, isDeleted: true });
  const remote = vocab({ updatedAt: 15_000 }, { definition: 'server edit' });
  assert.equal(merge(local, remote), local);
});

test('a server edit more than five seconds newer than a local deletion brings the card back, revisions aside', () => {
  const local = vocab({ updatedAt: 10_000, isDeleted: true });
  const remote = vocab({ updatedAt: 15_001 }, { definition: 'server edit' });
  const merged = merge(local, remote);
  assert.equal(merged.isDeleted, undefined);
  assert.equal(definitionOf(merged), 'server edit');
});

test('a local deletion at a newer revision wins, and yields to a newer server revision', () => {
  const local = vocab({ updatedAt: 1, serverRevision: 5, isDeleted: true });
  const remote = vocab({ updatedAt: 99_999, serverRevision: 4 }, { definition: 'server edit' });
  assert.equal(merge(local, remote), local);

  const ahead = { ...remote, serverRevision: 6 };
  const merged = merge(local, ahead);
  assert.equal(merged.isDeleted, undefined);
  assert.equal(definitionOf(merged), 'server edit');
  assert.equal(merged.serverRevision, 6);
});

test('a local deletion at the same revision stays deleted however new the server timestamp', () => {
  // The deletion rule lets the newer server timestamp through, but equal revisions share a base, so the
  // content step keeps the local copy, deletion included.
  const local = vocab({ updatedAt: 1_000, serverRevision: 5, isDeleted: true });
  const remote = vocab({ updatedAt: 100_000, serverRevision: 5 }, { definition: 'server edit' });
  const merged = merge(local, remote);
  assert.equal(merged.isDeleted, true);
  assert.equal(definitionOf(merged), definitionOf(local));
});

test('the deletion rule reads updatedAt alone, while the content step falls back to savedAt', () => {
  // No updatedAt: the deletion rule sees time 0 and lets the server copy through; the content step then
  // compares savedAt with the server's updatedAt, finds the local copy newer, and keeps its deletion.
  const local = vocab({ savedAt: 20_000, isDeleted: true });
  const remote = vocab({ updatedAt: 10_000 }, { definition: 'server edit' });
  const merged = merge(local, remote);
  assert.equal(merged.isDeleted, true);
  assert.equal(merged.updatedAt, 20_000);
  assert.equal(merged.savedAt, 20_000);
});

test('a deletion made here on top of a server rewrite carries the server copy with the deletion', () => {
  const base = synced(vocab({ updatedAt: 1, serverRevision: 10 }));
  const local: StoredItem = { ...base, isDeleted: true, updatedAt: 2 };
  const remote = vocab({ updatedAt: 3, serverRevision: 11, srs: schedule('w', 'vocab', { totalReviews: 4, lastReviewDate: 9 }) }, { definition: 'enriched' });
  const merged = merge(local, remote);
  assert.deepEqual(merged, { ...remote, isDeleted: true, updatedAt: 2, lastSyncedHash: base.lastSyncedHash });
  assert.notEqual(merged.data, remote.data, 'a copy, not the server object');
});

test('when both copies are deleted, the newer revision decides, else the newer timestamp, ties to this device', () => {
  const local = vocab({ updatedAt: 10, serverRevision: 3, isDeleted: true });
  const remote = vocab({ updatedAt: 5, serverRevision: 4, isDeleted: true });
  assert.equal(merge(local, remote), remote);
  const newerLocal = { ...local, serverRevision: 5 };
  assert.equal(merge(newerLocal, remote), newerLocal);

  const unrevisioned = { ...local, serverRevision: undefined };
  assert.equal(merge(unrevisioned, { ...remote, serverRevision: undefined, updatedAt: 11 }).updatedAt, 11);
  assert.equal(merge(unrevisioned, { ...remote, serverRevision: undefined, updatedAt: 10 }), unrevisioned);
  assert.equal(merge(unrevisioned, { ...remote, serverRevision: undefined, updatedAt: 9 }), unrevisioned);
});

test('an un-delete made here rebases onto a revision bump that kept the deleted content', () => {
  const deleted = synced(vocab({ updatedAt: 1, serverRevision: 4, isDeleted: true }));
  const restored: StoredItem = { ...deleted, isDeleted: undefined, updatedAt: 2 };
  const bumped: StoredItem = { ...vocab({ updatedAt: 1, serverRevision: 7, isDeleted: true }) };
  const merged = merge(restored, bumped);
  assert.equal(merged.isDeleted, undefined);
  assert.equal(merged.serverRevision, 7);
  assert.equal(merged.updatedAt, 2);
  assert.equal(isItemDirty(merged), true);
});

// --- Content ---

test('a newer local copy stripped of its content keeps the server content but its own timestamps and flags', () => {
  const stripped: StoredItem = { type: 'vocab', data: { id: 'w', word: 'w' } as VocabCard, savedAt: 1, updatedAt: 50, isArchived: true, srs: schedule('w', 'vocab') };
  const remote = vocab({ updatedAt: 10, savedAt: 2 }, { definition: 'full' });
  const merged = merge(stripped, remote);
  assert.equal(definitionOf(merged), 'full');
  assert.equal(merged.updatedAt, 50);
  assert.equal(merged.savedAt, 1);
  assert.equal(merged.isArchived, true);

  // When the server copy is stripped too, the newer local one is kept.
  const strippedRemote: StoredItem = { ...stripped, updatedAt: 10, data: { id: 'w', word: 'server' } as VocabCard };
  assert.equal((merge(stripped, strippedRemote).data as VocabCard).word, 'w');
});

test('content written over a server copy of another type keeps none of its server-owned fields', () => {
  const local = vocab({ serverRevision: 3, updatedAt: 1 });
  const remote: StoredItem = { ...phrase({ serverRevision: 3, updatedAt: 1 }, { id: 'w', usageAudit: { status: 'current_general', reason: 'x', confidence: 'high', auditedAt: 1 } }) };
  const merged = merge(local, remote);
  assert.equal(merged.type, 'phrase', 'the type comes from the server copy');
  assert.equal((merged.data as VocabCard).definition, 'definition w', 'the content from the local copy');
  assert.equal((merged.data as SearchResult).usageAudit, undefined);
});

test('a server copy that wins keeps its own extra fields and takes the local sync record', () => {
  const local = synced(vocab({ serverRevision: 3, updatedAt: 1 }));
  const remote = { ...vocab({ serverRevision: 4, updatedAt: 2 }, { definition: 'server edit' }), lastSyncedHash: 'remote record' };
  const merged = merge(local, remote);
  assert.equal(definitionOf(merged), 'server edit');
  assert.equal(merged.lastSyncedHash, local.lastSyncedHash);
});

// --- Schedule ---

test('an unsynced schedule keeps the newer review, and the review count breaks a tie', () => {
  const at = (lastReviewDate: number, totalReviews: number) => schedule('w', 'vocab', { lastReviewDate, totalReviews });
  const local = vocab({ updatedAt: 1, serverRevision: 2, srs: at(20, 1) });
  const remote = vocab({ updatedAt: 1, serverRevision: 3, srs: at(10, 5) });
  assert.equal(merge(local, remote).srs.lastReviewDate, 20, 'local reviewed later');

  assert.equal(merge({ ...local, srs: at(10, 6) }, remote).srs.totalReviews, 6, 'same review, more repetitions here');
  assert.equal(merge({ ...local, srs: at(10, 4) }, remote).srs.totalReviews, 5, 'same review, more repetitions there');
  // A newer server review wins, even when it holds fewer repetitions (a reset elsewhere).
  const reset = merge({ ...local, srs: at(10, 9) }, { ...remote, srs: at(30, 0) });
  assert.equal(reset.srs.totalReviews, 0);
  assert.equal(reset.srs.lastReviewDate, 30);
});

test('a clean copy takes the server schedule at the same or a newer revision, but not an older one', () => {
  const local = synced(vocab({ updatedAt: 1, serverRevision: 5, srs: schedule('w', 'vocab', { lastReviewDate: 20, totalReviews: 2 }) }));
  const older = vocab({ updatedAt: 1, serverRevision: 5, srs: schedule('w', 'vocab', { lastReviewDate: 10, totalReviews: 1 }) });
  assert.equal(merge(local, older).srs.totalReviews, 1, 'the same revision');
  assert.equal(merge(local, { ...older, serverRevision: 4 }).srs.totalReviews, 2, 'an older revision');
  assert.equal(merge(local, { ...older, serverRevision: undefined }).srs.totalReviews, 2, 'a copy without a revision');
});

test('passive exposure takes the later of the two, and adds nothing when neither copy has one', () => {
  const local = vocab({ updatedAt: 2, srs: schedule('w', 'vocab', { lastExposureDate: 5 }) });
  const remote = vocab({ updatedAt: 1 });
  assert.equal(merge(local, remote).srs.lastExposureDate, 5);
  assert.equal(merge(remote, local).srs.lastExposureDate, 5);
  assert.equal('lastExposureDate' in merge(vocab({ updatedAt: 2 }), remote).srs, false);
});

test('an unreviewed sentence has its legacy passive strength cleared whichever copy wins', () => {
  const local = sentence({ updatedAt: 9, srs: schedule('s', 'sentence', { memoryStrength: 40, stability: 6 }) });
  const remote = sentence({ updatedAt: 1, srs: schedule('s', 'sentence', { memoryStrength: 30, stability: 4 }) });
  const merged = merge(local, remote);
  assert.equal(merged.srs.memoryStrength, 0);
  assert.equal(merged.srs.stability, 0.5);
  assert.equal(merged.srs.lastExposureDate, 0, 'migrate fills the exposure clock');
});

// --- Images ---

const MARKER = 'server:has_image:aaaaaaaaaaaaaaaaaaaa';

test('a local picture is kept over an unversioned or older server marker, and a server picture fills a gap', () => {
  const local = vocab({ updatedAt: 5, serverRevision: 3 }, { imageUrl: 'idb:stored' });
  assert.equal((merge(local, vocab({ updatedAt: 1, serverRevision: 4 }, { imageUrl: 'server:has_image' })).data as VocabCard).imageUrl, 'idb:stored');
  assert.equal((merge(local, vocab({ updatedAt: 9, serverRevision: 2 }, { imageUrl: MARKER })).data as VocabCard).imageUrl, 'idb:stored');

  const bare = vocab({ updatedAt: 5, serverRevision: 3 });
  assert.equal((merge(bare, vocab({ updatedAt: 1, serverRevision: 2 }, { imageUrl: MARKER })).data as VocabCard).imageUrl, MARKER);
});

test('at the same revision a versioned server marker replaces the local one only if its copy is as new', () => {
  const local = vocab({ updatedAt: 5, serverRevision: 3 }, { imageUrl: 'idb:stored' });
  const imageOf = (remote: StoredItem) => (merge(local, remote).data as VocabCard).imageUrl;
  assert.equal(imageOf(vocab({ updatedAt: 5, serverRevision: 3 }, { imageUrl: MARKER })), MARKER);
  assert.equal(imageOf(vocab({ updatedAt: 4, serverRevision: 3 }, { imageUrl: MARKER })), 'idb:stored');
  // Without revisions on both copies, the timestamps decide alone.
  assert.equal(imageOf(vocab({ updatedAt: 5 }, { imageUrl: MARKER })), MARKER);
  assert.equal(imageOf(vocab({ updatedAt: 4, serverRevision: 9 }, { imageUrl: MARKER })), MARKER, 'a newer revision');
  const unrevisioned = { ...local, serverRevision: undefined };
  assert.equal((merge(unrevisioned, vocab({ updatedAt: 4, serverRevision: 9 }, { imageUrl: MARKER })).data as VocabCard).imageUrl, 'idb:stored');
});

test('phrase vocab pictures follow the same rules by id', () => {
  const local = phrase({ updatedAt: 5, serverRevision: 3 }, { vocabs: [card('a', { imageUrl: 'idb:stored' }), card('b')] });
  const remote = phrase({ updatedAt: 1, serverRevision: 2 }, { vocabs: [card('b', { imageUrl: MARKER }), card('a', { imageUrl: MARKER }), card('c', { imageUrl: MARKER })] });
  const vocabs = (merge(local, remote).data as SearchResult).vocabs;
  assert.deepEqual(vocabs.map(v => [v.id, v.imageUrl]), [['a', 'idb:stored'], ['b', MARKER]]);
});

// --- The pair as a whole ---

test('a copy without a schedule gets a new one before it merges', () => {
  const local = { ...vocab({ updatedAt: 1 }), srs: undefined } as unknown as StoredItem;
  const remote = { ...vocab({ updatedAt: 2 }, { definition: 'server edit' }), srs: undefined } as unknown as StoredItem;
  const merged = merge(local, remote);
  assert.deepEqual(merged.srs, {
    id: 'w', type: 'vocab', nextReview: Date.now(), interval: 0, memoryStrength: 0, lastReviewDate: 0,
    lastExposureDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5, scheduler: 'fsrs-v6', difficulty: 0,
    lapses: 0, fsrsState: 0, learningSteps: 0, scheduledDays: 0,
  });
  assert.equal(definitionOf(merged), 'server edit');
});

test('a merge that changes nothing keeps the local object, and any change makes a new one', () => {
  const local = synced(vocab({ updatedAt: 1, serverRevision: 3 }));
  assert.equal(merge(local, structuredClone({ ...local, lastSyncedHash: undefined })), local);
  const changed = merge(local, { ...vocab({ updatedAt: 1, serverRevision: 4 }, { definition: 'server edit' }) });
  assert.notEqual(changed, local);
  assert.equal(definitionOf(local), 'definition w', 'the local copy is never mutated');
});

test('the library merge keeps local order, appends new server items, and drops items without an id', () => {
  const a = vocab({ updatedAt: 1 }, { id: 'a' });
  const b = vocab({ updatedAt: 1 }, { id: 'b' });
  const noId = vocab({}, { id: '' });
  const newer = vocab({ updatedAt: 2 }, { id: 'b', definition: 'server edit' });
  const fresh = vocab({ updatedAt: 1 }, { id: 'c' });
  const merged = mergeDatasets([a, noId, b], [fresh, newer, noId]);
  assert.deepEqual(merged.map(item => item.data.id), ['a', 'b', 'c']);
  assert.equal(merged[0], a);
  assert.equal(definitionOf(merged[1]), 'server edit');
  assert.equal(merged[2], fresh);

  // A local copy without a schedule gets one even when the server doesn't send the item.
  const unscheduled = { ...a, srs: undefined } as unknown as StoredItem;
  assert.equal(mergeDatasets([unscheduled], [])[0].srs.totalReviews, 0);
  // The same id twice: the later local copy replaces the earlier in its place, and a second server copy
  // merges with the first.
  const twice = mergeDatasets([a, { ...a, updatedAt: 3 }, b], [{ ...fresh, updatedAt: 1 }, { ...fresh, updatedAt: 9 }]);
  assert.deepEqual(twice.map(item => [item.data.id, item.updatedAt]), [['a', 3], ['b', 1], ['c', 9]]);
});
