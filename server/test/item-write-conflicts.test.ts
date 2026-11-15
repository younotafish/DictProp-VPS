import assert from 'node:assert/strict';
import test from 'node:test';

const { db, getItemById, getItemImageBinary, upsertItem } = await import('../src/db.js');

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
  assert.match(stored?.data.imageUrl, /^server:has_image:/);
});

test('a stale phrase copy keeps the stored image of each vocab and fills in the missing ones', () => {
  const id = 'stale-phrase';
  const phrase = (vocabs: unknown[], extra: Record<string, unknown> = {}) => ({
    type: 'phrase',
    data: { id, query: 'see it clearly', vocabs, ...extra },
    srs: { id, type: 'phrase', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 1 },
    savedAt: 1,
    updatedAt: 1_000,
  });
  upsertItem(phrase([{ id: 'stale-phrase-kept', word: 'see', imageUrl: dataUri(pngVariant(4)) }]), USER);
  const first = revisionOf(id);
  upsertItem({ ...phrase([{ id: 'stale-phrase-kept', word: 'see', imageUrl: dataUri(pngVariant(5)) }], { note: 'newer' }), serverRevision: first, updatedAt: 2_000 }, USER);

  upsertItem({
    ...phrase([
      { id: 'stale-phrase-kept', word: 'see', imageUrl: dataUri(pngVariant(4)) },
      { id: 'stale-phrase-new', word: 'clearly', imageUrl: dataUri(pngVariant(6)) },
    ]),
    serverRevision: first,
  }, USER);
  assert.deepEqual(storedImage('stale-phrase-kept'), pngVariant(5));
  assert.deepEqual(storedImage('stale-phrase-new'), pngVariant(6));
});
