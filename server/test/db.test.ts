import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-db-test-'));

const { getItemById, getItemsAfterRevision, upsertItem, upsertItemImages, addReviewEvent, applyReviewEvent, undoReviewEvent, getReviewEvents, upsertItemImageBinary, createUserAndClaimItems, createSession, getSessionUser, deleteSession, db } = await import('../src/db.js');

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
  assert.ok(stored);
  assert.equal(stored.data.definition, 'new content');
  assert.equal(stored.srs.lastReviewDate, 2_000);
  assert.equal(stored.srs.totalReviews, 2);

  // A delayed request carries a newer review: retain content, accept its SRS.
  upsertItem(makeItem(id, 'stale content', 1_500, 4_000, 3), 'user-a');
  stored = getItemById(id, 'user-a');
  assert.ok(stored);
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
  assert.equal(getItemById(id, 'user-a')?.data.definition, 'owner data');
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
  assert.ok(stored);
  assert.equal(stored.data.definition, 'current');
  assert.equal(stored.updatedAt, 2_000);
});

test('review events are idempotent and user scoped', () => {
  const event = {
    id: 'review-1', itemId: 'revision-item', itemType: 'vocab' as const,
    reviewedAt: 5_000, previousStep: 0, nextStep: 1, rating: 'good' as const,
  };
  addReviewEvent(event, 'user-a');
  addReviewEvent(event, 'user-a');
  assert.deepEqual(getReviewEvents('user-a', 0), [event]);
  assert.deepEqual(getReviewEvents('user-b', 0), []);
});

test('concurrent review events advance authoritative item progress exactly once each', () => {
  const id = 'atomic-review-item';
  upsertItem(makeItem(id, 'review me', 10_000, 0, 0), 'review-user');
  const first = {
    id: 'atomic-review-1', itemId: id, itemType: 'vocab' as const,
    reviewedAt: 20_000, previousStep: 0, nextStep: 1,
  };
  const second = { ...first, id: 'atomic-review-2', reviewedAt: 20_001 };

  assert.equal(applyReviewEvent(first, [id], 'review-user')?.applied, true);
  assert.equal(applyReviewEvent(second, [id], 'review-user')?.applied, true);
  assert.equal(applyReviewEvent(first, [id], 'review-user')?.applied, false);
  assert.equal(getItemById(id, 'review-user')?.srs.totalReviews, 2);
  assert.deepEqual(
    getReviewEvents('review-user', 0).map(event => [event.previousStep, event.nextStep]),
    [[0, 1], [1, 2]],
  );

  assert.throws(
    () => undoReviewEvent(first.id, 'review-user'),
    /no longer the latest change/,
  );
  assert.equal(undoReviewEvent(second.id, 'review-user')?.undone, true);
  assert.equal(getItemById(id, 'review-user')?.srs.totalReviews, 1);
  assert.deepEqual(getReviewEvents('review-user', 0).map(event => event.id), [first.id]);
  assert.equal(undoReviewEvent(second.id, 'review-user')?.undone, false);
  assert.equal(undoReviewEvent(first.id, 'review-user')?.undone, true);
  assert.equal(getItemById(id, 'review-user')?.srs.totalReviews, 0);
  assert.deepEqual(getReviewEvents('review-user', 0), []);
});

test('revision cursor returns every row when revisions are tied', () => {
  upsertItem(makeItem('cursor-a', 'a', 1, 0, 0), 'cursor-user');
  upsertItem(makeItem('cursor-b', 'b', 1, 0, 0), 'cursor-user');
  const revision = 999_999;
  db.prepare(`UPDATE items SET revision = ? WHERE user_id = ?`).run(revision, 'cursor-user');

  const first = getItemsAfterRevision({ revision: 0, id: '' }, 1, true, 'cursor-user');
  const second = getItemsAfterRevision(first.cursor, 1, true, 'cursor-user');
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].data.id, second.items[0].data.id);
});

test('session bearer tokens are hashed at rest and remain revocable', () => {
  const user = createUserAndClaimItems({
    googleId: 'session-google-id',
    email: 'session@example.com',
    displayName: 'Session Test',
    photoUrl: null,
  });
  const session = createSession(user.id);
  const stored = db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(user.id) as { token: string };
  assert.notEqual(stored.token, session.token);
  assert.equal(stored.token.length, 64);
  assert.equal(getSessionUser(session.token)?.id, user.id);
  deleteSession(session.token);
  assert.equal(getSessionUser(session.token), null);
});
