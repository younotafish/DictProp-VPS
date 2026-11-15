import assert from 'node:assert/strict';
import test from 'node:test';

const { db, getItemById, upsertItem } = await import('../src/db.js');

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
