import assert from 'node:assert/strict';
import test from 'node:test';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { advanceReviewSrs } from '../src/srs.js';
import type { ReviewRating } from '../src/srs.js';

test('legacy fixed-schedule rows migrate lazily for every FSRS rating', () => {
  const legacy = {
    id: 'legacy', type: 'vocab' as const, nextReview: 30 * 86_400_000,
    interval: 7 * 1440, memoryStrength: 37, lastReviewDate: 23 * 86_400_000,
    totalReviews: 3, correctStreak: 3, stability: 7,
  };
  const reviewedAt = 31 * 86_400_000;

  for (const rating of ['again', 'hard', 'good', 'easy'] satisfies ReviewRating[]) {
    const migrated = SRSAlgorithm.updateAfterRating(legacy, rating, reviewedAt);
    assert.equal(migrated.scheduler, 'fsrs-v6');
    assert.equal(migrated.totalReviews, 4);
    assert.equal(migrated.lastReviewDate, reviewedAt);
    assert.ok(migrated.nextReview > reviewedAt);
    assert.equal(legacy.totalReviews, 3);
    assert.equal('scheduler' in legacy, false);
  }
});

test('reviewing one sense leaves the same-spelling sibling untouched', () => {
  const reviewedAt = 10 * 86_400_000;
  const firstSense = SRSAlgorithm.createNew('lead-metal', 'vocab');
  const secondSense = SRSAlgorithm.createNew('lead-guide', 'vocab');
  const updatedFirst = SRSAlgorithm.updateAfterRating(firstSense, 'good', reviewedAt);

  assert.equal(updatedFirst.totalReviews, 1);
  assert.equal(secondSense.totalReviews, 0);
  assert.equal(secondSense.lastReviewDate, 0);
  assert.notEqual(updatedFirst.id, secondSense.id);
});

test('client preview and server-authoritative review transitions stay identical', () => {
  const reviewedAt = 40 * 86_400_000;
  const base = {
    ...SRSAlgorithm.createNew('parity', 'vocab'),
    nextReview: 10 * 86_400_000,
    lastReviewDate: 9 * 86_400_000,
    totalReviews: 4,
    correctStreak: 4,
    stability: 5,
  };

  for (const rating of ['again', 'hard', 'good', 'easy'] satisfies ReviewRating[]) {
    assert.deepEqual(
      advanceReviewSrs(base, reviewedAt, rating),
      SRSAlgorithm.updateAfterRating(base, rating, reviewedAt),
    );
  }
});

test('autoplay exposure adds one quarter of a Good strength gain without recording a review', () => {
  const now = 50 * 86_400_000;
  const base = {
    ...SRSAlgorithm.createNew('sentence', 'sentence'),
    nextReview: 40 * 86_400_000,
  };
  const remembered = SRSAlgorithm.updateAfterRemember(base, now);
  const exposed = SRSAlgorithm.updateAfterExposure(base, 0.25, now);
  const rawStrength = (stability: number) => 18 * Math.log(1 + stability);

  assert.ok(Math.abs(
    (rawStrength(exposed.stability) - rawStrength(base.stability)) -
    (rawStrength(remembered.stability) - rawStrength(base.stability)) * 0.25,
  ) < 1e-9);
  assert.equal(exposed.totalReviews, base.totalReviews);
  assert.equal(exposed.correctStreak, base.correctStreak);
  assert.equal(exposed.lastReviewDate, base.lastReviewDate);
  assert.equal(exposed.nextReview, base.nextReview);
  assert.ok(exposed.memoryStrength > base.memoryStrength);
});
