import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareReviewProgress, isStaleContent, resolveSrs, sortedKeys, splitInlineImages, withPoolAnalysis,
} from '../src/db/item-write.js';

const schedule = (lastReviewDate: number, totalReviews: number, lastExposureDate?: number) =>
  ({ lastReviewDate, totalReviews, ...(lastExposureDate === undefined ? {} : { lastExposureDate }) });

test('review progress is ordered by the last review, then by the number of reviews', () => {
  assert.equal(compareReviewProgress(schedule(2, 1), schedule(1, 9)), 1);
  assert.equal(compareReviewProgress(schedule(1, 9), schedule(2, 1)), -1);
  assert.equal(compareReviewProgress(schedule(2, 3), schedule(2, 2)), 1);
  assert.equal(compareReviewProgress(schedule(2, 2), schedule(2, 2)), 0);
  // A missing or unreadable schedule counts as no progress.
  assert.equal(compareReviewProgress(undefined, null), 0);
  assert.equal(compareReviewProgress(schedule(1, 0), { lastReviewDate: 'soon' }), 1);
});

test('the schedule with newer review progress wins, and only newer incoming progress counts as a change', () => {
  const stored = schedule(2_000, 2);
  assert.deepEqual(resolveSrs(stored, schedule(1_000, 1)), { srs: stored, changed: false });
  const newer = schedule(3_000, 3);
  assert.deepEqual(resolveSrs(stored, newer), { srs: newer, changed: true });
  const tie = schedule(2_000, 2);
  const resolved = resolveSrs(stored, tie);
  assert.equal(resolved.srs, tie);
  assert.equal(resolved.changed, false);
});

test('the newest listen survives whichever schedule wins, and a newer incoming listen is a change', () => {
  // The stored review wins, but the incoming copy has the newer listen.
  assert.deepEqual(resolveSrs(schedule(2_000, 2, 3_000), schedule(1_000, 1, 5_000)), {
    srs: schedule(2_000, 2, 5_000), changed: true,
  });
  // The incoming review wins, but the stored copy has the newer listen.
  assert.deepEqual(resolveSrs(schedule(2_000, 2, 5_000), schedule(6_000, 3, 4_000)), {
    srs: schedule(6_000, 3, 5_000), changed: true,
  });
  // Nothing newer arrives: the stored schedule comes back as it is.
  const stored = schedule(2_000, 2, 5_000);
  assert.deepEqual(resolveSrs(stored, schedule(1_000, 1, 4_000)), { srs: stored, changed: false });
});

test('content is stale by server revision when the copy carries one, otherwise by its clock', () => {
  const clocks = { storedRevision: 5, storedUpdatedAt: 2_000 };
  assert.equal(isStaleContent({ ...clocks, incomingRevision: 4, incomingUpdatedAt: 9_999 }), true);
  assert.equal(isStaleContent({ ...clocks, incomingRevision: 5, incomingUpdatedAt: 1 }), false);
  assert.equal(isStaleContent({ ...clocks, incomingRevision: undefined, incomingUpdatedAt: 1_999 }), true);
  assert.equal(isStaleContent({ ...clocks, incomingRevision: undefined, incomingUpdatedAt: 2_000 }), false);
});

test('a sentence without an analysis takes the pool\'s, and one with an analysis keeps its own', () => {
  const pool = { analysis: { translation: 'pool' }, generatedAt: 7 };
  const bare = { id: 's', text: 'A lucid account.' };
  assert.deepEqual(withPoolAnalysis(bare, pool), {
    data: { id: 's', text: 'A lucid account.', analysis: pool.analysis, analysisGeneratedAt: 7 }, enriched: true,
  });
  const analysed = { ...bare, analysis: { translation: 'own' } };
  assert.equal(withPoolAnalysis(analysed, pool).data, analysed);
  assert.equal(withPoolAnalysis(analysed, pool).enriched, false);
  assert.deepEqual(withPoolAnalysis(bare, null), { data: bare, enriched: false });
});

test('stored item data loses every imageUrl, and only inline images are taken out to be stored', () => {
  const inline = (seed: string) => `data:image/png;base64,${Buffer.from(seed).toString('base64')}`;
  const plainVocab = { id: 'plain', word: 'plain' };
  const { stored, itemImage, vocabImages } = splitInlineImages({
    id: 'p',
    query: 'see it clearly',
    imageUrl: inline('item'),
    vocabs: [
      { id: 'inline', word: 'clearly', imageUrl: inline('vocab') },
      { id: 'marker', word: 'see', imageUrl: 'server:has_image:0123' },
      plainVocab,
      { word: 'no id', imageUrl: inline('orphan') },
      { id: 7, word: 'numbered', imageUrl: inline('numbered') },
      null,
      'stray',
    ],
  });
  assert.deepEqual(stored, {
    id: 'p',
    query: 'see it clearly',
    vocabs: [
      { id: 'inline', word: 'clearly' }, { id: 'marker', word: 'see' }, plainVocab, { word: 'no id' },
      { id: 7, word: 'numbered' }, null, 'stray',
    ],
  });
  assert.equal((stored.vocabs as unknown[])[2], plainVocab);
  assert.deepEqual(itemImage, { id: 'p', dataUri: inline('item') });
  assert.deepEqual(vocabImages, [
    { id: 'inline', dataUri: inline('vocab') }, { id: '7', dataUri: inline('numbered') },
  ]);

  const marked = splitInlineImages({ id: 'v', word: 'lucid', imageUrl: 'idb:stored' });
  assert.deepEqual(marked, { stored: { id: 'v', word: 'lucid' }, itemImage: undefined, vocabImages: [] });
});

test('sorting keys makes copies that differ only in key order serialize alike', () => {
  assert.equal(
    JSON.stringify(sortedKeys({ b: 1, a: [{ d: 1, c: 2 }], e: null })),
    JSON.stringify(sortedKeys({ e: null, a: [{ c: 2, d: 1 }], b: 1 })),
  );
  assert.equal(JSON.stringify(sortedKeys({ a: [1, 2] })), '{"a":[1,2]}');
});
