import assert from 'node:assert/strict';
import test from 'node:test';
import { finiteNonNegative, nextUpdatedAt, normalizedSrs, SRS_COUNTERS } from '../src/scripts/support/stored-item.js';
import { validateStoredItem } from '../src/validation.js';

test('a stored number is kept only when it is finite and not negative', () => {
  assert.equal(finiteNonNegative(0), 0);
  assert.equal(finiteNonNegative(12.5), 12.5);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
    assert.equal(finiteNonNegative(value), 0, String(value));
    assert.equal(finiteNonNegative(value, 7), 7, String(value));
  }
});

test('a normalized SRS record keeps its other fields and their order, takes the item\'s identity, and repairs every counter', () => {
  const item = { type: 'vocab', data: { id: 'word' } };
  const source = {
    stability: 3, id: 'stale-id', lastExposureDate: 9, nextReview: -4, interval: Number.NaN, totalReviews: 2, extra: 'kept',
  };
  const srs = normalizedSrs(item, source);
  assert.deepEqual(Object.entries(srs), [
    ['stability', 3], ['id', 'word'], ['lastExposureDate', 9], ['nextReview', 0], ['interval', 0], ['totalReviews', 2],
    ['extra', 'kept'], ['type', 'vocab'], ['memoryStrength', 0], ['lastReviewDate', 0], ['correctStreak', 0],
  ]);
  assert.deepEqual(SRS_COUNTERS.filter(field => !(field in srs)), []);
  // What the repair produces is what validation requires.
  assert.equal(validateStoredItem({ type: 'vocab', data: { id: 'word', word: 'word' }, srs, savedAt: 1 }), null);
  // Without a source, the item's own record is the source; without one at all, every counter starts at 0.
  assert.equal(normalizedSrs({ ...item, srs: { nextReview: 5 } }).nextReview, 5);
  assert.deepEqual(normalizedSrs(item), {
    id: 'word', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0,
    correctStreak: 0, stability: 0,
  });
});

test('the next updatedAt is now, or just after the stored one when that is later', () => {
  assert.equal(nextUpdatedAt(100, 1_000), 1_000);
  assert.equal(nextUpdatedAt(5_000, 1_000), 5_001);
  assert.equal(nextUpdatedAt(undefined, 1_000), 1_000);
  assert.ok(nextUpdatedAt(0) >= Date.now() - 1_000);
});
