import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewTaskType, SRSData } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { previewRatings, updateAfterRating } from '../../services/fsrsScheduler.ts';
import { advanceReviewSrs } from '../../server/src/srs.js';
import type { ReviewRating } from '../../server/src/srs.js';
import { isRatingAllowedForTask, REVIEW_TASK_TYPES } from '../../server/src/shared/review.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 5, 9);
const RATINGS = ['again', 'hard', 'good', 'easy'] as const satisfies readonly ReviewRating[];
// ts-fsrs's State: 0 New, 1 Learning, 2 Review, 3 Relearning.
const LEARNING = 1, REVIEW = 2, RELEARNING = 3;

/** Today's practice membership (server/src/shared/practice.ts), which a review decides along with the schedule. */
const MEMBERSHIP_FIELDS = ['practiceSince', 'sayableAt', 'practiceChangedAt'] as const;
/** Everything a review decides; the server's result replaces the device's on the next sync. */
const SCHEDULE_FIELDS = [
  'nextReview', 'interval', 'stability', 'difficulty', 'totalReviews', 'lapses', 'fsrsState', 'learningSteps',
  'scheduledDays', 'memoryStrength', 'correctStreak', 'lastReviewDate', 'scheduler', ...MEMBERSHIP_FIELDS,
] as const;
const scheduleOf = (srs: object) => Object.fromEntries(SCHEDULE_FIELDS.map(field => [field, (srs as Record<string, unknown>)[field]]));
/** The membership keys a schedule holds; an absent one is deleted, never left undefined or null. */
const membershipOf = (srs: object) => Object.fromEntries(MEMBERSHIP_FIELDS.filter(field => field in srs).map(field => [field, (srs as Record<string, unknown>)[field]]));

/** The server's step on its stored row, and the device's on its migrated copy, as each runs it for a review. */
const serverStep = (row: SRSData, rating: ReviewRating, at: number, taskType?: ReviewTaskType) =>
  advanceReviewSrs(row, at, rating, taskType);
const deviceStep = (row: SRSData, rating: ReviewRating, at: number, taskType?: ReviewTaskType) =>
  updateAfterRating(SRSAlgorithm.ensure(row, row.id, row.type), rating, at, taskType);
/** Both steps, checked to agree on every field; the server's result, which every device keeps. */
const bothSteps = (row: SRSData, rating: ReviewRating, at: number, taskType?: ReviewTaskType, label = '') => {
  const fromServer = serverStep(row, rating, at, taskType);
  assert.deepEqual(scheduleOf(deviceStep(row, rating, at, taskType)), scheduleOf(fromServer), `${label} ${taskType} ${rating}`);
  assert.deepEqual(membershipOf(deviceStep(row, rating, at, taskType)), membershipOf(fromServer), `${label} ${taskType} ${rating}`);
  return fromServer;
};

/** A card's schedule after the server applied these reviews to a card saved at T0. */
function reviewed(steps: [rating: ReviewRating, at: number][], type: SRSData['type'] = 'vocab'): SRSData {
  return steps.reduce<SRSData>((row, [rating, at]) => serverStep(row, rating, at), SRSAlgorithm.createNew('card', type, T0));
}

/** A new card met in a set and put in practice at T0, then said right a minute later in the set's round. */
function joinedAndRounded(): SRSData {
  const joined = bothSteps(SRSAlgorithm.createNew('card', 'vocab', T0), 'again', T0, 'triage', 'meet');
  return bothSteps(joined, 'good', T0 + MINUTE, 'speak', 'round');
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
    // Malformed: the server's validation requires both. The device used to compute a NaN schedule from it.
    ['row missing its interval and review date', {
      id: 'card', type: 'vocab', nextReview: 30 * DAY, memoryStrength: 20, lastReviewDate: 0, totalReviews: 2,
      correctStreak: 2, stability: 3,
    } as Omit<SRSData, 'interval'> as SRSData, 32 * DAY],
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

test('a set item put in practice graduates to "can say it" on the spoken success after the 18-day gap, on both sides', () => {
  let row = joinedAndRounded();
  assert.deepEqual(membershipOf(row), { practiceSince: T0, practiceChangedAt: T0 });
  // Said right each time it comes due. Only the success after the 18-day gap is both 14 or more days after the review
  // before it and leaves 21 days of stability.
  const gaps: number[] = [];
  while (row.practiceSince !== undefined) {
    assert.ok(gaps.length < 6, 'graduates within six reviews');
    gaps.push(Math.round((row.nextReview - row.lastReviewDate) / DAY));
    row = bothSteps(row, 'good', row.nextReview, 'speak', `after ${gaps.at(-1)} days`);
  }
  assert.deepEqual(gaps, [1, 2, 6, 18]);
  assert.equal(row.fsrsState, REVIEW);
  assert.ok(row.stability >= 21, `${row.stability}`);
  assert.deepEqual(membershipOf(row), { sayableAt: row.lastReviewDate, practiceChangedAt: row.lastReviewDate });
});

test('graduation waits for a 14-day gap and 21 days of stability, and takes only an unaided success', () => {
  let row = joinedAndRounded();
  for (let review = 0; review < 3; review++) row = bothSteps(row, 'good', row.nextReview, 'speak');
  // Due in 18 days with 17.6 days of stability: a success a minute short of 14 days leaves more than 21, but too soon.
  const early = bothSteps(row, 'good', row.lastReviewDate + 14 * DAY - MINUTE, 'speak', 'a minute short of 14 days');
  assert.ok(early.stability >= 21 && early.fsrsState === REVIEW, `${early.stability}`);
  assert.deepEqual(membershipOf(early), { practiceSince: T0, practiceChangedAt: T0 });
  const onTheDay = bothSteps(row, 'good', row.lastReviewDate + 14 * DAY, 'speak', '14 days');
  assert.deepEqual(membershipOf(onTheDay), { sayableAt: onTheDay.lastReviewDate, practiceChangedAt: onTheDay.lastReviewDate });
  // A success with a hint or on the second try is hard, which never graduates.
  const hinted = bothSteps(row, 'hard', row.nextReview, 'speak', 'hinted');
  assert.ok(hinted.stability >= 21, `${hinted.stability}`);
  assert.deepEqual(membershipOf(hinted), { practiceSince: T0, practiceChangedAt: T0 });
  // A long gap alone doesn't graduate a weak memory: the round's 1-day item said right a month on.
  const weak = bothSteps(joinedAndRounded(), 'good', T0 + MINUTE + 30 * DAY, 'speak', 'a month on');
  assert.ok(weak.stability < 21, `${weak.stability}`);
  assert.deepEqual(membershipOf(weak), { practiceSince: T0, practiceChangedAt: T0 });
});

test('on meeting a set item, Practice joins, Passive keeps it passive and "can say it" marks it, on both sides', () => {
  const fresh = SRSAlgorithm.createNew('card', 'sentence', T0);
  const sayable = bothSteps(fresh, 'easy', T0, 'triage', 'can say it');
  assert.deepEqual(membershipOf(sayable), { sayableAt: T0, practiceChangedAt: T0 });
  assert.equal(Math.round((sayable.nextReview - T0) / DAY), 8);
  // Passive is a decision too: it is stamped, so a set never offers the item again.
  assert.deepEqual(membershipOf(bothSteps(fresh, 'good', T0, 'triage', 'passive')), { practiceChangedAt: T0 });
  // A sentence reviewed before in the classic way (a Got it) is met in a set like a new one.
  const gotIt = bothSteps(fresh, 'good', T0, 'quick', 'got it');
  assert.deepEqual(membershipOf(gotIt), {});
  assert.deepEqual(membershipOf(bothSteps(gotIt, 'again', T0 + DAY, 'triage', 'practice after a got it')), { practiceSince: T0 + DAY, practiceChangedAt: T0 + DAY });
  assert.deepEqual(membershipOf(bothSteps(gotIt, 'good', T0 + DAY, 'triage', 'passive after a got it')), { practiceChangedAt: T0 + DAY });
  // A later Passive takes an item out of practice, as a later decision on another device would.
  const joined = bothSteps(fresh, 'again', T0, 'triage', 'joined');
  assert.deepEqual(membershipOf(bothSteps(joined, 'good', T0 + DAY, 'triage', 'passive later')), { practiceChangedAt: T0 + DAY });
  // The practice toggle elsewhere: adding an item clears "can say it", adding it again keeps the first join, and
  // removing it marks it as one you can say.
  const added = bothSteps(sayable, 'again', T0 + DAY, 'triage', 'added');
  assert.deepEqual(membershipOf(added), { practiceSince: T0 + DAY, practiceChangedAt: T0 + DAY });
  const addedAgain = bothSteps(added, 'again', T0 + 2 * DAY, 'triage', 'added again');
  assert.deepEqual(membershipOf(addedAgain), { practiceSince: T0 + DAY, practiceChangedAt: T0 + 2 * DAY });
  const removed = bothSteps(addedAgain, 'easy', T0 + 3 * DAY, 'triage', 'removed');
  assert.deepEqual(membershipOf(removed), { sayableAt: T0 + 3 * DAY, practiceChangedAt: T0 + 3 * DAY });
});

test('a triage made before the last change of membership schedules but leaves membership alone', () => {
  const joined = bothSteps(SRSAlgorithm.createNew('card', 'vocab', T0), 'again', T0 + HOUR, 'triage');
  // A device that was offline sends "can say it", made a minute before the join.
  const stale = bothSteps(joined, 'easy', T0 + HOUR - MINUTE, 'triage', 'stale');
  assert.equal(stale.totalReviews, joined.totalReviews + 1);
  assert.deepEqual(membershipOf(stale), membershipOf(joined));
  // The server stamps a late review no earlier than the last one, and judges it by when it was made.
  const clamped = advanceReviewSrs(joined, joined.lastReviewDate, 'easy', 'triage', T0 + HOUR - MINUTE);
  assert.equal(clamped.totalReviews, joined.totalReviews + 1);
  assert.deepEqual(membershipOf(clamped), membershipOf(joined));
  // One made after the change applies, at the time the server stamps it with.
  const later = advanceReviewSrs(joined, T0 + 2 * HOUR, 'easy', 'triage', T0 + 2 * HOUR - MINUTE);
  assert.deepEqual(membershipOf(later), { sayableAt: T0 + 2 * HOUR, practiceChangedAt: T0 + 2 * HOUR });
});

test('Quiet practice, a Got it and classic Study schedule a practicing item but never graduate it', () => {
  for (const taskType of ['recall', 'quick', 'meaning'] as const) {
    let row = joinedAndRounded();
    for (let review = 0; review < 7; review++) row = bothSteps(row, 'good', row.nextReview, taskType, `review ${review + 1}`);
    assert.ok(row.stability > 200, `${taskType}: ${row.stability} days`);
    assert.deepEqual(membershipOf(row), { practiceSince: T0, practiceChangedAt: T0 }, taskType);
  }
});

test('a reset drops practice membership with the rest of the progress, and the next triage starts it afresh', () => {
  const sayable = bothSteps(SRSAlgorithm.createNew('card', 'vocab', T0), 'easy', T0, 'triage');
  assert.ok(sayable.sayableAt !== undefined);
  const reset = SRSAlgorithm.reset('card', 'vocab', T0 + DAY);
  assert.deepEqual(membershipOf(reset), {});
  assert.deepEqual(membershipOf(bothSteps(reset, 'again', T0 + DAY + HOUR, 'triage')), {
    practiceSince: T0 + DAY + HOUR, practiceChangedAt: T0 + DAY + HOUR,
  });
});

test('the device and the server agree along 300 random task-typed reviews, membership included', () => {
  let seed = 20_261_118;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  // Every task type with every rating it takes.
  const pairs = REVIEW_TASK_TYPES.flatMap(taskType =>
    RATINGS.filter(rating => isRatingAllowedForTask(taskType, rating)).map(rating => [taskType, rating] as const));
  const triages = pairs.filter(([taskType]) => taskType === 'triage');
  let row = SRSAlgorithm.createNew('walk', 'vocab', T0);
  let at = T0;
  const transitions = { joined: 0, markedSayable: 0, graduated: 0, staleTriage: 0 };
  for (let step = 0; step < 300; step++) {
    // From a minute to two months, evenly on a log scale. Now and then a triage dated a little before the last review,
    // as a device whose clock runs behind sends; otherwise half the reviews are spoken successes, so practice builds
    // the stability graduation needs.
    const gap = Math.round(Math.exp(random() * Math.log((60 * DAY) / MINUTE)) * MINUTE);
    const behind = random() < 0.1;
    at += behind ? -Math.min(gap, HOUR) : gap;
    const [taskType, rating] = behind ? triages[Math.floor(random() * triages.length)]
      : random() < 0.5 ? ['speak', 'good'] as const : pairs[Math.floor(random() * pairs.length)];
    const next = bothSteps(row, rating, at, taskType, `review ${step + 1}`);
    if ((row.practiceChangedAt ?? 0) > at && taskType === 'triage') transitions.staleTriage++;
    if (row.practiceSince === undefined && next.practiceSince !== undefined) transitions.joined++;
    if (row.sayableAt === undefined && next.sayableAt !== undefined) {
      if (taskType === 'speak') transitions.graduated++;
      else transitions.markedSayable++;
    }
    row = next;
  }
  for (const [kind, count] of Object.entries(transitions)) assert.ok(count > 0, `the walk has no ${kind}`);
});

test('a review dated before the last one, from a clock running behind, is stamped at the last review on both sides', () => {
  // The last review a few seconds after a UTC midnight, and a device whose clock still reads the day before.
  const lastReview = Date.UTC(2026, 0, 10, 0, 0, 30);
  const due = reviewed([['good', T0], ['good', T0 + 2 * DAY]]);
  const row = { ...due, lastReviewDate: lastReview, nextReview: lastReview + 6 * DAY };
  for (const rating of RATINGS) {
    const behind = bothSteps(row, rating, lastReview - 2 * MINUTE, undefined, 'clock behind');
    assert.equal(behind.lastReviewDate, lastReview, rating);
    assert.deepEqual(scheduleOf(behind), scheduleOf(serverStep(row, rating, lastReview)), rating);
  }
});
