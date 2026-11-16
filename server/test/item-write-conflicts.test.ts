import assert from 'node:assert/strict';
import test from 'node:test';

const { applyReviewEvent, db, getItemById, getItemImageBinary, undoReviewEvent, upsertItem } = await import('../src/db.js');

const USER = 'conflict-user';
const vocab = (id: string, extra: Record<string, unknown> = {}, srs: Record<string, unknown> = {}) => ({
  type: 'vocab',
  data: { id, word: id, definition: `definition of ${id}`, ...extra },
  srs: {
    id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0,
    lastReviewDate: 1_000, totalReviews: 1, correctStreak: 1, stability: 1, ...srs,
  },
  savedAt: 1,
  updatedAt: 1_000,
});
const revisionOf = (id: string) => (db.prepare('SELECT revision FROM items WHERE id = ?').get(id) as { revision: number }).revision;

const usageAudit = { status: 'current_general', checkedAt: 5, model: 'm', contentHash: 'a'.repeat(64) };
const advancedEnrichment = { version: 1, provider: 'claude-code', model: 'm', generatedAt: 5, contentHash: 'b'.repeat(64) };

test('a copy lacking only the kept server fields takes no new revision, whatever order the row stores them in', () => {
  // Stored in the reverse of the order the server adds kept fields back in.
  const id = 'kept-fields-order';
  upsertItem(vocab(id, { advancedEnrichment, usageAudit }), USER);
  const revision = revisionOf(id);

  const result = upsertItem({ ...vocab(id), serverRevision: revision }, USER);
  assert.deepEqual(result, { revision, conflicted: false });
  assert.equal(revisionOf(id), revision);
  assert.deepEqual(getItemById(id, USER)?.data.usageAudit, usageAudit);
});

test('a schedule that differs only in key order counts as unchanged', () => {
  const id = 'reordered-schedule';
  upsertItem(vocab(id, { usageAudit }), USER);
  const revision = revisionOf(id);

  const copy = vocab(id);
  const reordered = { ...copy, srs: Object.fromEntries(Object.entries(copy.srs).reverse()), serverRevision: revision };
  assert.deepEqual(upsertItem(reordered, USER), { revision, conflicted: false });
});

test('a copy that changes content still takes a new revision and keeps the server fields', () => {
  const id = 'kept-fields-edit';
  upsertItem(vocab(id, { advancedEnrichment, usageAudit }), USER);
  const revision = revisionOf(id);

  const result = upsertItem({ ...vocab(id, { definition: 'edited' }), serverRevision: revision, updatedAt: 2_000 }, USER);
  assert.ok(result.revision > revision);
  const stored = getItemById(id, USER)?.data;
  assert.equal(stored?.definition, 'edited');
  assert.deepEqual(stored?.advancedEnrichment, advancedEnrichment);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const pngVariant = (seed: number) => Buffer.concat([png, Buffer.from([seed])]);
const dataUri = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const storedImage = (id: string) => getItemImageBinary(id, USER)?.data;

test('a stale copy never replaces a newer stored image', () => {
  const id = 'stale-image';
  upsertItem(vocab(id, { imageUrl: dataUri(pngVariant(1)) }), USER);
  const first = revisionOf(id);
  upsertItem({ ...vocab(id, { definition: 'newer', imageUrl: dataUri(pngVariant(2)) }), serverRevision: first, updatedAt: 2_000 }, USER);
  const newer = revisionOf(id);
  assert.ok(newer > first);

  // A copy made before that edit carries the first image inline.
  const result = upsertItem({ ...vocab(id, { imageUrl: dataUri(pngVariant(1)) }), serverRevision: first }, USER);
  assert.deepEqual(result, { revision: newer, conflicted: true });
  assert.deepEqual(storedImage(id), pngVariant(2));
  assert.equal(getItemById(id, USER)?.data.definition, 'newer');
});

test('a stale copy fills in an image the server lacks, at a revision delta clients see', () => {
  const id = 'stale-fills-image';
  upsertItem(vocab(id), USER);
  const first = revisionOf(id);
  upsertItem({ ...vocab(id, { definition: 'newer' }), serverRevision: first, updatedAt: 2_000 }, USER);
  const newer = revisionOf(id);

  const result = upsertItem({ ...vocab(id, { imageUrl: dataUri(pngVariant(3)) }), serverRevision: first }, USER);
  assert.equal(result.conflicted, true);
  assert.ok(result.revision > newer);
  assert.equal(revisionOf(id), result.revision);
  assert.deepEqual(storedImage(id), pngVariant(3));
  const stored = getItemById(id, USER, false);
  assert.equal(stored?.data.definition, 'newer');
  assert.match(String(stored?.data.imageUrl), /^server:has_image:/);
});

const phrase = (id: string, vocabs: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'phrase',
  data: { id, query: 'see it clearly', vocabs, ...extra },
  srs: { id, type: 'phrase', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 1 },
  savedAt: 1,
  updatedAt: 1_000,
});

test('a stale phrase copy keeps the stored image of each vocab and fills in the missing ones', () => {
  const id = 'stale-phrase';
  upsertItem(phrase(id, [
    { id: 'stale-phrase-kept', word: 'see', imageUrl: dataUri(pngVariant(4)) },
    { id: 'stale-phrase-bare', word: 'clearly' },
  ]), USER);
  const first = revisionOf(id);
  upsertItem({
    ...phrase(id, [
      { id: 'stale-phrase-kept', word: 'see', imageUrl: dataUri(pngVariant(5)) },
      { id: 'stale-phrase-bare', word: 'clearly' },
    ], { note: 'newer' }),
    serverRevision: first,
    updatedAt: 2_000,
  }, USER);
  const newer = revisionOf(id);

  const result = upsertItem({
    ...phrase(id, [
      { id: 'stale-phrase-kept', word: 'see', imageUrl: dataUri(pngVariant(4)) },
      { id: 'stale-phrase-bare', word: 'clearly', imageUrl: dataUri(pngVariant(6)) },
    ]),
    serverRevision: first,
  }, USER);
  assert.deepEqual(storedImage('stale-phrase-kept'), pngVariant(5));
  assert.deepEqual(storedImage('stale-phrase-bare'), pngVariant(6));
  // The filled-in image's marker reaches delta clients with a new revision.
  assert.equal(result.conflicted, true);
  assert.ok(result.revision > newer);
  const vocabs = getItemById(id, USER, false)?.data.vocabs as Array<{ imageUrl?: string }> | undefined;
  assert.match(String(vocabs?.[1].imageUrl), /^server:has_image:/);
});

test('a stale phrase copy stores no image for a vocab the stored phrase lacks, and takes no revision for it', () => {
  const id = 'stale-phrase-extra';
  upsertItem(phrase(id, [{ id: 'stale-phrase-extra-kept', word: 'see' }]), USER);
  const first = revisionOf(id);
  upsertItem({
    ...phrase(id, [{ id: 'stale-phrase-extra-kept', word: 'see' }], { note: 'newer' }), serverRevision: first, updatedAt: 2_000,
  }, USER);
  const newer = revisionOf(id);

  // A copy made before that edit adds a vocab with a picture; its content loses to the newer row.
  const result = upsertItem({
    ...phrase(id, [
      { id: 'stale-phrase-extra-kept', word: 'see' },
      { id: 'stale-phrase-extra-new', word: 'clearly', imageUrl: dataUri(pngVariant(7)) },
    ]),
    serverRevision: first,
  }, USER);
  assert.deepEqual(result, { revision: newer, conflicted: true });
  assert.equal(revisionOf(id), newer);
  assert.equal(storedImage('stale-phrase-extra-new'), undefined);
  const vocabIds = (getItemById(id, USER, false)?.data.vocabs as Array<{ id: string }> | undefined)?.map(vocab => vocab.id);
  assert.deepEqual(vocabIds, ['stale-phrase-extra-kept']);
});

/** An item reviewed once and then undone, and the copy another device pulled between the two. */
function reviewedThenUndone(id: string) {
  upsertItem(vocab(id), USER);
  const review = { id: `${id}-review`, itemId: id, itemType: 'vocab' as const, reviewedAt: 5_000, previousStep: 1, nextStep: 2 };
  assert.equal(applyReviewEvent(review, [id], USER)?.applied, true);
  const pulled = getItemById(id, USER, false)!;
  assert.equal(pulled.srs.totalReviews, 2);
  assert.equal(undoReviewEvent(review.id, USER)?.undone, true);
  const restored = getItemById(id, USER, false)!;
  assert.equal(restored.srs.totalReviews, 1);
  return { pulled, restored };
}

test('a stale copy pulled before an undo cannot bring the undone review back', () => {
  const id = 'undone-stale';
  const { pulled, restored } = reviewedThenUndone(id);
  const result = upsertItem({ ...pulled, data: { ...pulled.data, definition: 'edited on the other device' }, updatedAt: 9_000 }, USER);
  assert.deepEqual(result, { revision: restored.serverRevision, conflicted: true });
  const stored = getItemById(id, USER, false)!;
  assert.deepEqual(stored.srs, restored.srs);
  assert.equal(stored.data.definition, restored.data.definition);
});

test('a current copy carrying an undone review saves its content and keeps the restored schedule', () => {
  const id = 'undone-current';
  const { pulled, restored } = reviewedThenUndone(id);
  // The other device rebased its edit onto the undo's revision but kept the reviewed schedule.
  const result = upsertItem({
    ...pulled, data: { ...pulled.data, definition: 'rebased edit' }, serverRevision: restored.serverRevision, updatedAt: 9_000,
  }, USER);
  assert.equal(result.conflicted, false);
  const stored = getItemById(id, USER, false)!;
  assert.equal(stored.data.definition, 'rebased edit');
  assert.deepEqual(stored.srs, restored.srs);
});

test('a newer listen on a copy carrying an undone review still counts', () => {
  const id = 'undone-listened';
  const { pulled, restored } = reviewedThenUndone(id);
  const result = upsertItem({ ...pulled, srs: { ...pulled.srs, lastExposureDate: 7_000 } }, USER);
  assert.equal(result.conflicted, true);
  assert.ok(result.revision > restored.serverRevision!);
  assert.deepEqual(getItemById(id, USER, false)!.srs, { ...restored.srs, lastExposureDate: 7_000 });
});

test('a review made after the undo is newer progress again', () => {
  const id = 'undone-then-reviewed';
  const { restored } = reviewedThenUndone(id);
  const later = { ...restored, srs: { ...restored.srs, lastReviewDate: 6_000, totalReviews: 2 }, updatedAt: 9_000 };
  assert.equal(upsertItem(later, USER).conflicted, false);
  assert.equal(getItemById(id, USER, false)!.srs.lastReviewDate, 6_000);
});
