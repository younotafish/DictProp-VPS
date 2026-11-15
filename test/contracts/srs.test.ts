import assert from 'node:assert/strict';
import test from 'node:test';
import type { SRSData } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { previewRatings, updateAfterRating } from '../../services/fsrsScheduler.ts';
import { advanceReviewSrs } from '../../server/src/srs.js';
import type { ReviewRating } from '../../server/src/srs.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 5, 9);
const RATINGS = ['again', 'hard', 'good', 'easy'] as const satisfies readonly ReviewRating[];
// ts-fsrs's State: 0 New, 1 Learning, 2 Review, 3 Relearning.
const LEARNING = 1, REVIEW = 2, RELEARNING = 3;

/** Everything a review decides; the server's result replaces the device's on the next sync. */
const SCHEDULE_FIELDS = [
  'nextReview', 'interval', 'stability', 'difficulty', 'totalReviews', 'lapses', 'fsrsState', 'learningSteps',
  'scheduledDays', 'memoryStrength', 'correctStreak', 'lastReviewDate', 'scheduler',
] as const;
const scheduleOf = (srs: object) => Object.fromEntries(SCHEDULE_FIELDS.map(field => [field, (srs as Record<string, unknown>)[field]]));

/** The server's step on its stored row, and the device's on its migrated copy, as each runs it for a review. */
const serverStep = (row: SRSData, rating: ReviewRating, at: number) => advanceReviewSrs(row, at, rating);
const deviceStep = (row: SRSData, rating: ReviewRating, at: number) =>
  updateAfterRating(SRSAlgorithm.ensure(row, row.id, row.type), rating, at);

/** A card's schedule after the server applied these reviews to a card saved at T0. */
function reviewed(steps: [rating: ReviewRating, at: number][], type: SRSData['type'] = 'vocab'): SRSData {
  return steps.reduce<SRSData>((row, [rating, at]) => serverStep(row, rating, at), SRSAlgorithm.createNew('card', type, T0));
}

test('legacy fixed-schedule rows migrate lazily for every FSRS rating', () => {
  const legacy = {
    id: 'legacy', type: 'vocab' as const, nextReview: 30 * 86_400_000,
    interval: 7 * 1440, memoryStrength: 37, lastReviewDate: 23 * 86_400_000,
    totalReviews: 3, correctStreak: 3, stability: 7,
  };
  const reviewedAt = 31 * 86_400_000;

  for (const rating of ['again', 'hard', 'good', 'easy'] satisfies ReviewRating[]) {
    const migrated = updateAfterRating(legacy, rating, reviewedAt);
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
  const updatedFirst = updateAfterRating(firstSense, 'good', reviewedAt);

  assert.equal(updatedFirst.totalReviews, 1);
  assert.equal(secondSense.totalReviews, 0);
  assert.equal(secondSense.lastReviewDate, 0);
  assert.notEqual(updatedFirst.id, secondSense.id);
});

test('the device and the server schedule every kind of card alike, for every rating', () => {
  const learning = reviewed([['again', T0]]);
  const review = reviewed([['good', T0], ['good', T0 + 2 * DAY]]);
  const relearning = reviewed([['good', T0], ['good', T0 + 2 * DAY], ['again', review.nextReview]]);
  const leech = reviewed([['again', T0], ['again', T0 + 10 * MINUTE], ['again', T0 + 20 * MINUTE]]);
  assert.equal(learning.fsrsState, LEARNING);
  assert.equal(review.fsrsState, REVIEW);
  assert.equal(relearning.fsrsState, RELEARNING);
  assert.ok(leech.stability < 0.1, 'a leech falls below the 0.1 stability floor both copies apply');

  const cases: [name: string, row: SRSData, at: number][] = [
    ['new', SRSAlgorithm.createNew('card', 'vocab', T0), T0 + HOUR],
    ['learning, at its 10-minute step', learning, learning.nextReview],
    ['learning, before its step', learning, T0 + 2 * MINUTE],
    ['relearning after a lapse', relearning, relearning.nextReview],
    ['review, due', review, review.nextReview],
    ['review, early', review, review.nextReview - 5 * DAY],
    ['review, late', review, review.nextReview + 40 * DAY],
    ['review, again the same day', review, review.lastReviewDate + HOUR],
    ['leech below the stability floor', leech, leech.nextReview],
    ['legacy fixed-schedule row', {
      id: 'card', type: 'vocab', nextReview: 30 * DAY, interval: 7 * 1440, memoryStrength: 37,
      lastReviewDate: 23 * DAY, totalReviews: 3, correctStreak: 3, stability: 7,
    }, 31 * DAY],
    ['legacy row without a review date', {
      id: 'card', type: 'phrase', nextReview: 30 * DAY, interval: 3 * 1440, memoryStrength: 25,
      lastReviewDate: 0, totalReviews: 2, correctStreak: 2, stability: 3,
    }, 32 * DAY],
    ['reset', SRSAlgorithm.reset('card', 'vocab', T0 + 30 * DAY), T0 + 30 * DAY + HOUR],
    ['sentence never reviewed, with a leftover stability', {
      ...SRSAlgorithm.createNew('card', 'sentence', T0), stability: 9, memoryStrength: 42,
    }, T0 + DAY],
  ];
  for (const [name, row, at] of cases) {
    for (const rating of RATINGS) {
      assert.deepEqual(scheduleOf(deviceStep(row, rating, at)), scheduleOf(serverStep(row, rating, at)), `${name}, ${rating}`);
    }
  }
});

test('the device and the server agree along 300 random reviews at random gaps', () => {
  let seed = 20_261_115;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  let row = SRSAlgorithm.createNew('walk', 'vocab', T0);
  let at = T0;
  for (let step = 0; step < 300; step++) {
    // From a minute to about half a year, evenly on a log scale, so every state and interval comes up.
    at += Math.round(Math.exp(random() * Math.log((180 * DAY) / MINUTE)) * MINUTE);
    const rating = RATINGS[Math.floor(random() * RATINGS.length)];
    const fromServer = serverStep(row, rating, at);
    assert.deepEqual(scheduleOf(deviceStep(row, rating, at)), scheduleOf(fromServer), `review ${step + 1}, ${rating}`);
    row = fromServer;
  }
});

test('the first grades of a new card follow the 10-minute learning step, as the rating buttons show', () => {
  const previews = previewRatings(SRSAlgorithm.createNew('card', 'vocab', T0), T0);
  assert.deepEqual(RATINGS.map(rating => [previews[rating].interval, previews[rating].fsrsState]), [
    [10, LEARNING], // Again: 10 minutes
    [15, LEARNING], // Hard: 15 minutes
    [2 * 1440, REVIEW], // Good: 2 days
    [8 * 1440, REVIEW], // Easy: 8 days
  ]);
});

test('passive exposure records recency without changing memorization or review state', () => {
  const now = 50 * 86_400_000;
  const base = {
    ...SRSAlgorithm.createNew('sentence', 'sentence'),
    nextReview: 40 * 86_400_000,
  };
  const exposed = SRSAlgorithm.updateAfterExposure(base, now);

  assert.equal(exposed.lastExposureDate, now);
  assert.equal(exposed.totalReviews, base.totalReviews);
  assert.equal(exposed.correctStreak, base.correctStreak);
  assert.equal(exposed.lastReviewDate, base.lastReviewDate);
  assert.equal(exposed.nextReview, base.nextReview);
  assert.equal(exposed.stability, base.stability);
  assert.equal(exposed.memoryStrength, base.memoryStrength);
  assert.equal(exposed.fsrsState, base.fsrsState);
});

test('migrating a never-reviewed item does not manufacture display strength from seed stability', () => {
  const pollutedByLegacyExposure = {
    ...SRSAlgorithm.createNew('fresh-sentence', 'sentence'),
    memoryStrength: 42,
    stability: 9,
  };
  const migrated = SRSAlgorithm.migrate(pollutedByLegacyExposure);
  assert.equal(migrated.memoryStrength, 0);
  assert.equal(migrated.stability, 0.5);
  assert.equal(migrated.totalReviews, 0);
});

test('a reset starts over with its own time as the review clock, which the first review after it ignores', () => {
  const resetAt = 40 * 86_400_000;
  const reset = SRSAlgorithm.reset('reset', 'vocab', resetAt);
  assert.equal(reset.totalReviews, 0);
  assert.equal(reset.lastReviewDate, resetAt);
  assert.equal(reset.nextReview, resetAt);

  const fresh = { ...SRSAlgorithm.createNew('reset', 'vocab'), nextReview: resetAt };
  const reviewedAt = resetAt + 3_600_000;
  assert.deepEqual(updateAfterRating(reset, 'good', reviewedAt), updateAfterRating(fresh, 'good', reviewedAt));
  assert.deepEqual(advanceReviewSrs(reset, reviewedAt, 'good'), advanceReviewSrs(fresh, reviewedAt, 'good'));
});
