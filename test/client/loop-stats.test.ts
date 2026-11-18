import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent, ReviewHistory, ReviewTaskType } from '../../types.ts';
import { localDayKey, localDayStart } from '../../services/learningLoop/standing.ts';
import {
  DAILY_SET_GOAL,
  isDoneForToday,
  isPracticeFirst,
  loopProgress,
  loopStreak,
  nextPracticeClockChange,
  setDaysLoader,
  sortedThisWeek,
  todayAction,
  todaySetCount,
} from '../../services/learningLoop/stats.ts';
import { DAY, HOUR, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const MIDNIGHT = localDayStart(NOW);

let nextEvent = 0;
const event = (itemId: string, reviewedAt: number, extra: Partial<ReviewEvent> & { taskType?: ReviewTaskType } = {}): ReviewEvent => ({
  id: `e${nextEvent++}`, itemId, itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 1, rating: 'good',
  taskType: 'triage', sessionId: 'set:s1', ...extra,
});
const history = (recent: ReviewEvent[]): ReviewHistory => ({ recent, olderTimes: [], olderCount: 0 });

test('today\'s count is the distinct items first met in a set since local midnight', () => {
  const recent = [
    event('a', MIDNIGHT + HOUR),
    event('a', MIDNIGHT + 2 * HOUR, { rating: 'easy' }), // met again after Back: still one item
    event('b', NOW, { rating: 'again', sessionId: 'set:s2' }),
    event('c', MIDNIGHT - 1), // yesterday
    event('d', MIDNIGHT + HOUR, { previousStep: 3, nextStep: 4 }), // not its first review
    event('e', MIDNIGHT + HOUR, { taskType: 'speak', sessionId: 'set:s1' }), // the round
    event('f', MIDNIGHT + HOUR, { sessionId: undefined }), // the practice toggle
    event('g', MIDNIGHT + HOUR, { sessionId: 'practice:p1' }),
    event('h', localDayStart(NOW, 1)), // stamped tomorrow
  ];
  assert.equal(todaySetCount(history(recent), NOW), 2);
  assert.equal(todaySetCount(history([]), NOW), 0);
});

test('the streak counts back from yesterday over days that met the goal, and today joins once met', () => {
  const day = (back: number) => localDayKey(localDayStart(NOW, -back));
  const days = { [day(1)]: 12, [day(2)]: 20, [day(3)]: 12, [day(4)]: 11, [day(5)]: 30 };
  assert.equal(loopStreak(days, 0, NOW), 3, 'today unmet doesn\'t break it');
  assert.equal(loopStreak(days, DAILY_SET_GOAL, NOW), 4);
  assert.equal(loopStreak({ [day(2)]: 12 }, 3, NOW), 0, 'yesterday missed');
  assert.equal(loopStreak({ [day(0)]: 99 }, 3, NOW), 0, 'today comes from this device, which knows its unsent reviews');
  assert.equal(loopStreak({}, DAILY_SET_GOAL, NOW), 1);
  assert.equal(loopStreak({ constructor: 99 } as Record<string, number>, 0, NOW), 0);
});

test('the streak walks calendar days, across a daylight-saving change too', () => {
  const saved = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // New York falls back on 2026-11-01; on the 3rd the streak reaches back over it.
    const now = new Date(2026, 10, 3, 12).getTime();
    const days = { '2026-11-02': 12, '2026-11-01': 12, '2026-10-31': 12, '2026-10-30': 2 };
    assert.equal(loopStreak(days, 0, now), 3);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('the set days load once a day and offset, and a failed load is tried again', async () => {
  const loads: number[] = [];
  let fail = true;
  const load = setDaysLoader(async offset => {
    loads.push(offset);
    if (fail) throw new Error('offline');
    return { days: { '2026-11-17': 15 } };
  });
  await assert.rejects(load(NOW), /offline/);
  fail = false;
  assert.deepEqual(await load(NOW), { '2026-11-17': 15 }, 'the failure wasn\'t kept');
  assert.deepEqual(await load(NOW + HOUR), { '2026-11-17': 15 });
  assert.equal(loads.length, 2, 'the same day loads once');
  await load(NOW + DAY);
  assert.equal(loads.length, 3, 'a new day loads again');
  assert.deepEqual(new Set(loads), new Set([-new Date(NOW).getTimezoneOffset(), -new Date(NOW + DAY).getTimezoneOffset()]));
});

test('the progress line counts what you can say (and this week\'s), practice, tomorrow\'s practice and this week\'s saves', () => {
  const items = [
    vocabItem('say-old', 'a', { srs: sayable(NOW - 30 * DAY) }),
    vocabItem('say-new', 'b', { srs: sayable(localDayStart(NOW, -6)) }),
    vocabItem('due', 'c', { srs: practicing(NOW - 9 * DAY, { nextReview: NOW - HOUR, lastReviewDate: MIDNIGHT - DAY }) }),
    vocabItem('done-today', 'd', { srs: practicing(NOW - 9 * DAY, { nextReview: NOW + DAY, lastReviewDate: MIDNIGHT + HOUR }) }),
    vocabItem('later', 'e', { srs: practicing(NOW - 9 * DAY, { nextReview: localDayStart(NOW, 2), lastReviewDate: MIDNIGHT - DAY }) }),
    vocabItem('passive', 'f', { srs: reviewed(NOW - DAY) }),
    vocabItem('saved', 'g', { savedAt: localDayStart(NOW, -6) }),
    vocabItem('saved-earlier', 'h', { savedAt: localDayStart(NOW, -7) }),
    sentenceItem('sentence', 'A {{line}}.', { translation: null, savedAt: NOW - HOUR }),
    sentenceItem('real-life-sentence:x:y:01', 'Line.', { catalogKind: 'real-life', catalogSentenceId: 'x:y:01', catalogCollectionId: 'x', savedAt: NOW }),
    vocabItem('gone', 'i', { isDeleted: true, savedAt: NOW, srs: sayable(NOW) }),
    vocabItem('kept', 'j', { isArchived: true, savedAt: NOW, srs: practicing(NOW, { nextReview: NOW - 1, lastReviewDate: MIDNIGHT - DAY }) }),
  ];
  assert.deepEqual(loopProgress(items, NOW), {
    sayable: 2, sayableThisWeek: 1, practicing: 3, practiceDue: 1, tomorrow: 2, savedThisWeek: 2,
  });
});

test('sorted this week counts each item\'s first triage, in a set or with the toggle, over today and the six days before', () => {
  const weekStart = localDayStart(NOW, -6);
  const recent = [
    event('a', weekStart), event('a', NOW), event('b', NOW, { sessionId: undefined }),
    event('c', weekStart - 1), event('d', NOW, { previousStep: 2 }), event('e', NOW, { taskType: 'quick', sessionId: undefined }),
  ];
  assert.equal(sortedThisWeek(history(recent), NOW), 2);
});

test('the plan offers practice while any is due, then a set until the goal is met, then done', () => {
  assert.deepEqual(todayAction(8, 0, true), { kind: 'practice', count: 8 });
  assert.deepEqual(todayAction(46, 12, true), { kind: 'practice', count: 30 }, 'a session takes at most 30');
  assert.deepEqual(todayAction(0, 9, true), { kind: 'set' });
  assert.deepEqual(todayAction(0, 9, false), { kind: 'no-set' }, 'themes still sorting, or none left');
  assert.deepEqual(todayAction(0, 11, true), { kind: 'set' });
  assert.deepEqual(todayAction(0, 12, true), { kind: 'done' }, 'one set meets the goal');
  assert.equal(DAILY_SET_GOAL, 12);
  assert.equal(isDoneForToday(12, 0), true);
  assert.equal(isDoneForToday(12, 1), false);
  assert.equal(isDoneForToday(11, 0), false);
  assert.equal(isPracticeFirst(39), false);
  assert.equal(isPracticeFirst(40), true);
});

test('the practice count next changes when an item not reviewed today falls due, or at midnight', () => {
  const tonight = localDayStart(NOW, 1);
  const item = (id: string, nextReview: number, lastReviewDate = MIDNIGHT - DAY) =>
    vocabItem(id, id, { srs: practicing(NOW - 9 * DAY, { nextReview, lastReviewDate }) });
  assert.equal(nextPracticeClockChange([], NOW), tonight);
  assert.equal(nextPracticeClockChange([item('a', NOW + 2 * HOUR), item('b', NOW + HOUR)], NOW), NOW + HOUR);
  // Already due, due after midnight, reviewed today (its 10-minute step), or not in practice: nothing before midnight.
  const unchanged = [
    item('due', NOW - HOUR),
    item('later', tonight + HOUR),
    item('today', NOW + 10 * 60_000, MIDNIGHT + HOUR),
    vocabItem('passive', 'passive', { srs: reviewed(MIDNIGHT - DAY, { nextReview: NOW + HOUR }) }),
    { ...item('kept', NOW + HOUR), isArchived: true },
  ];
  assert.equal(nextPracticeClockChange(unchanged, NOW), tonight);
});
