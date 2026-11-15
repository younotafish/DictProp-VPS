import assert from 'node:assert/strict';
import test from 'node:test';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';

test('display strength is 18·ln(1 + stability), rounded and capped, as the table in its doc says', () => {
  const table: [stability: number, strength: number][] = [
    [1, 12], [3, 25], [7, 37], [12, 46], [25, 59], [47, 70], [84, 80], [143, 89], [180, 94],
  ];
  for (const [stability, strength] of table) {
    assert.equal(SRSAlgorithm.stabilityToDisplayStrength(stability), strength, `stability ${stability}`);
  }
  assert.equal(SRSAlgorithm.stabilityToDisplayStrength(0), 0);
  assert.equal(SRSAlgorithm.stabilityToDisplayStrength(-3), 0);
  assert.equal(SRSAlgorithm.stabilityToDisplayStrength(10_000), 100);
});

test('a new record is due at its creation time, and a reset stamps its own time as the review clock', () => {
  const created = SRSAlgorithm.createNew('fresh', 'vocab', 1_000);
  assert.equal(created.nextReview, 1_000);
  assert.equal(created.lastReviewDate, 0);
  assert.equal(created.totalReviews, 0);

  const reset = SRSAlgorithm.reset('fresh', 'phrase', 2_000);
  assert.deepEqual(reset, { ...SRSAlgorithm.createNew('fresh', 'phrase', 2_000), lastReviewDate: 2_000 });
});

test('ensure creates a record for an item without one and migrates one that exists', () => {
  const created = SRSAlgorithm.ensure(undefined, 'missing', 'sentence');
  assert.equal(created.id, 'missing');
  assert.equal(created.type, 'sentence');
  assert.equal(created.totalReviews, 0);

  // The methods don't depend on `this`, so they still work detached, as callbacks.
  const { ensure, migrate } = SRSAlgorithm;
  const legacy = { id: 'old', type: 'vocab' as const, nextReview: 5, interval: 1_440, memoryStrength: 0, lastReviewDate: 4, totalReviews: 2, correctStreak: 2, stability: 7 };
  assert.deepEqual(ensure(legacy, 'old', 'vocab'), migrate(legacy));
  assert.equal(migrate(legacy).memoryStrength, 37);
  assert.equal(migrate(legacy).lastExposureDate, 0);
});
