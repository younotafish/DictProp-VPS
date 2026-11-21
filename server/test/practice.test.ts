import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPracticeMembership, GRADUATION_MIN_GAP_DAYS, GRADUATION_STABILITY_DAYS, practiceTransition,
} from '../src/shared/practice.js';

// The membership step itself; test/contracts/srs.test.ts runs it through both schedulers with real FSRS schedules.

const DAY = 86_400_000;

test('a membership change deletes the key it ends, and leaves the scheduler result alone when nothing changes', () => {
  const next = { practiceSince: 1, practiceChangedAt: 1, stability: 3, fsrsState: 2 };
  const sayable = applyPracticeMembership({ practiceSince: 1, practiceChangedAt: 1 }, next, 'triage', 'easy', 50, 60);
  assert.deepEqual(sayable, { practiceChangedAt: 60, stability: 3, fsrsState: 2, sayableAt: 60 });
  assert.equal('practiceSince' in sayable, false);
  assert.equal(applyPracticeMembership({}, next, 'quick', 'good', 50, 60), next);
  // Passive ends both keys and keeps the time it was decided.
  const passive = applyPracticeMembership({ practiceSince: 1, practiceChangedAt: 1 }, next, 'triage', 'good', 50, 60);
  assert.deepEqual(passive, { practiceChangedAt: 60, stability: 3, fsrsState: 2 });
  assert.equal(practiceTransition({}, {}, 'triage', 'good', 50, 60), 'passive');
  assert.equal(practiceTransition({ practiceChangedAt: 70 }, {}, 'triage', 'good', 50, 60), 'none', 'a stale decision');
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
