import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-db-test-'));

const { getItemById, upsertItem, upsertItemImages, addReviewEvent, getReviewEvents, upsertItemImageBinary, db } = await import('../src/db.js');

const makeItem = (
  id: string,
  definition: string,
  updatedAt: number,
  lastReviewDate: number,
  totalReviews: number,
) => ({
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
    totalReviews,
    correctStreak: totalReviews,
    stability: 1,
  },
  savedAt: 1,
  updatedAt,
});

test('content and SRS resolve conflicts using independent clocks', () => {
  const id = 'conflict-item';
  upsertItem(makeItem(id, 'original', 2_000, 2_000, 2), 'user-a');

  // A newer edit loaded old study progress: accept its content, retain newer SRS.
  upsertItem(makeItem(id, 'new content', 3_000, 1_000, 1), 'user-a');
  let stored = getItemById(id, 'user-a');
  assert.equal(stored.data.definition, 'new content');
  assert.equal(stored.srs.lastReviewDate, 2_000);
  assert.equal(stored.srs.totalReviews, 2);

  // A delayed request carries a newer review: retain content, accept its SRS.
  upsertItem(makeItem(id, 'stale content', 1_500, 4_000, 3), 'user-a');
  stored = getItemById(id, 'user-a');
  assert.equal(stored.data.definition, 'new content');
  assert.equal(stored.srs.lastReviewDate, 4_000);
  assert.equal(stored.srs.totalReviews, 3);
});

test('item ids cannot overwrite another user', () => {
  const id = 'owned-item';
  upsertItem(makeItem(id, 'owner data', 1_000, 1_000, 1), 'user-a');
  assert.throws(
    () => upsertItem(makeItem(id, 'attacker data', 2_000, 2_000, 2), 'user-b'),
    /belongs to another user/,
  );
  assert.equal(getItemById(id, 'user-a').data.definition, 'owner data');
  assert.equal(getItemById(id, 'user-b'), null);
});

test('image ids cannot overwrite another user', () => {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  assert.equal(upsertItemImages([{ id: 'owned-image', data: image }], 'user-a'), 1);
  assert.equal(upsertItemImages([{ id: 'owned-image', data: image }], 'user-b'), 0);
  assert.equal(upsertItemImages([{ id: 'duplicate-image', data: image }], 'user-a'), 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM image_blobs').get() as { count: number }).count, 1);
  assert.equal(upsertItemImageBinary('fake-image', Buffer.from('not an image'), 'image/png', 'user-a'), false);
});

test('server revisions reject stale content independently of device clocks', () => {
  const id = 'revision-item';
  const revision = upsertItem(makeItem(id, 'current', 2_000, 0, 0), 'user-a').revision;
  const stale = { ...makeItem(id, 'stale but future clock', 99_999, 0, 0), serverRevision: revision - 1 };
  assert.deepEqual(upsertItem(stale, 'user-a'), { revision, conflicted: true });
  const stored = getItemById(id, 'user-a');
  assert.equal(stored.data.definition, 'current');
  assert.equal(stored.updatedAt, 2_000);
});

test('review events are idempotent and user scoped', () => {
  const event = {
    id: 'review-1', itemId: 'revision-item', itemType: 'vocab' as const,
    reviewedAt: 5_000, previousStep: 0, nextStep: 1,
  };
  addReviewEvent(event, 'user-a');
  addReviewEvent(event, 'user-a');
  assert.deepEqual(getReviewEvents('user-a', 0), [event]);
  assert.deepEqual(getReviewEvents('user-b', 0), []);
});
