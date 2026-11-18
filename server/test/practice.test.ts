import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPracticeMembership, GRADUATION_MIN_GAP_DAYS, GRADUATION_STABILITY_DAYS, loopStanding, practiceTransition,
} from '../src/shared/practice.js';

// The membership step itself; test/contracts/srs.test.ts runs it through both schedulers with real FSRS schedules.

const DAY = 86_400_000;

test('where an item stands in the loop follows its schedule alone', () => {
  assert.equal(loopStanding(undefined), 'new');
  assert.equal(loopStanding({ totalReviews: 0 }), 'new');
  assert.equal(loopStanding({ totalReviews: 3 }), 'reviewed');
  assert.equal(loopStanding({ totalReviews: 3, practiceSince: 1 }), 'practicing');
  assert.equal(loopStanding({ totalReviews: 3, sayableAt: 1 }), 'sayable');
  // Membership comes only from a review, so a never-reviewed schedule holding it is one whose count lags (a legacy row).
  assert.equal(loopStanding({ totalReviews: 0, practiceSince: 1 }), 'practicing');
});

test('a membership change deletes the key it ends, and leaves the scheduler result alone when nothing changes', () => {
  const next = { practiceSince: 1, practiceChangedAt: 1, stability: 3, fsrsState: 2 };
  const sayable = applyPracticeMembership({ practiceSince: 1, practiceChangedAt: 1 }, next, 'triage', 'easy', 50, 60);
  assert.deepEqual(sayable, { practiceChangedAt: 60, stability: 3, fsrsState: 2, sayableAt: 60 });
  assert.equal('practiceSince' in sayable, false);
  assert.equal(applyPracticeMembership({}, next, 'quick', 'good', 50, 60), next);
});

test('graduation reads the thresholds, inclusive, from the schedule after the review and the review before it', () => {
  const previous = { lastReviewDate: 0 };
  const after = { practiceSince: 1, fsrsState: 2, stability: GRADUATION_STABILITY_DAYS };
  const gap = GRADUATION_MIN_GAP_DAYS * DAY;
  assert.equal(practiceTransition(previous, after, 'speak', 'good', gap, gap), 'sayable');
  assert.equal(practiceTransition(previous, after, 'speak', 'good', gap - 1, gap - 1), 'none');
  assert.equal(practiceTransition(previous, { ...after, stability: GRADUATION_STABILITY_DAYS - 0.01 }, 'speak', 'good', gap, gap), 'none');
  assert.equal(practiceTransition(previous, { ...after, fsrsState: 3 }, 'speak', 'good', gap, gap), 'none');
  assert.equal(practiceTransition(previous, { fsrsState: 2, stability: 30 }, 'speak', 'good', gap, gap), 'none');
});
