import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-review-undo-srs-test-'));
process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { applyReviewEvent, db, getItemById, getReviewEvents, undoReviewEvent, upsertItem } = await import('../src/db.js');
const { DEV_AUTH_USER } = await import('../src/middleware/auth.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const vocabItem = (id: string) => ({
  type: 'vocab',
  data: {
    id, word: id, chinese: '', ipa: '', definition: `definition ${id}`,
    synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
  },
  srs: {
    id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0,
    lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5,
  },
  savedAt: 1,
  updatedAt: 1,
});
const review = (id: string, itemId: string) => ({
  id, itemId, itemType: 'vocab' as const, reviewedAt: Date.now(), previousStep: 0, nextStep: 1, rating: 'good' as const,
});
const storedSrs = (id: string) => (db.prepare('SELECT srs FROM items WHERE id = ?').get(id) as { srs: string }).srs;
const apply = (body: unknown) => app.request('/api/reviews/apply', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a review can be undone after a device saves its schedule back with the keys in another order', () => {
  const user = 'undo-user';
  upsertItem(vocabItem('reordered'), user);
  assert.equal(applyReviewEvent(review('reordered-review', 'reordered'), ['reordered'], user)?.applied, true);
  const reviewed = getItemById('reordered', user, false)!;
  const applied = storedSrs('reordered');

  // The device saves an edit, carrying the schedule it pulled with its keys reversed.
  const srs = Object.fromEntries(Object.entries(reviewed.srs).reverse());
  upsertItem({ ...reviewed, data: { ...reviewed.data, definition: 'edited after the review' }, srs, updatedAt: Date.now() + 1_000 }, user);
  assert.notEqual(storedSrs('reordered'), applied);
  assert.deepEqual(JSON.parse(storedSrs('reordered')), JSON.parse(applied));

  assert.equal(undoReviewEvent('reordered-review', user)?.undone, true);
  const undone = getItemById('reordered', user, false)!;
  assert.equal(undone.srs.totalReviews, 0);
  assert.equal(undone.data.definition, 'edited after the review');
});

test('a review that fails after its seed is stored leaves no seed behind', async () => {
  upsertItem(vocabItem('other-users-item'), 'other-user');
  assert.equal(applyReviewEvent(review('reused-review-id', 'other-users-item'), ['other-users-item'], 'other-user')?.applied, true);

  // This review reuses another user's event id, for an item the server hasn't stored yet.
  const response = await apply({ event: review('reused-review-id', 'unsynced'), itemIds: ['unsynced'], seedItem: vocabItem('unsynced') });
  assert.equal(response.status, 409);
  assert.match((await response.json() as any).error, /belongs to another user/);
  assert.equal((await app.request('/api/items/unsynced')).status, 404);
  assert.equal(getItemById('unsynced', DEV_AUTH_USER.id), null);
  assert.deepEqual(getReviewEvents(DEV_AUTH_USER.id, 0), []);
});

test('a seed for an id another user holds is refused and changes nothing', async () => {
  upsertItem(vocabItem('held-elsewhere'), 'other-user');
  const response = await apply({ event: review('held-elsewhere-review', 'held-elsewhere'), itemIds: ['held-elsewhere'], seedItem: vocabItem('held-elsewhere') });
  assert.equal(response.status, 409);
  assert.equal(getItemById('held-elsewhere', DEV_AUTH_USER.id), null);
  assert.equal(getItemById('held-elsewhere', 'other-user')?.srs.totalReviews, 0);
  assert.deepEqual(getReviewEvents(DEV_AUTH_USER.id, 0), []);
});
