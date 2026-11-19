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
import { DAY, HOUR, passive, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const MIDNIGHT = localDayStart(NOW);

let nextEvent = 0;
const event = (itemId: string, reviewedAt: number, extra: Partial<ReviewEvent> & { taskType?: ReviewTaskType } = {}): ReviewEvent => ({
  id: `e${nextEvent++}`, itemId, itemType: 'sentence', reviewedAt, previousStep: 0, nextStep: 1, rating: 'good',
  taskType: 'triage', sessionId: 'set:s1', ...extra,
});
const history = (recent: ReviewEvent[]): ReviewHistory => ({ recent, olderTimes: [], olderCount: 0 });

test('today\'s count is the distinct sentences decided in a set since local midnight, whatever reviews they had before', () => {
  const recent = [
    event('a', MIDNIGHT + HOUR),
    event('a', MIDNIGHT + 2 * HOUR, { rating: 'easy', previousStep: 1, nextStep: 2 }), // met again after Back: still one
    event('b', NOW, { rating: 'again', sessionId: 'set:s2' }),
    event('c', MIDNIGHT - 1), // yesterday
    event('d', MIDNIGHT + HOUR, { previousStep: 3, nextStep: 4 }), // Got it'd three times in the Sentences tab first
    event('e', MIDNIGHT + HOUR, { taskType: 'speak', sessionId: 'set:s1' }), // the round
    event('f', MIDNIGHT + HOUR, { sessionId: undefined }), // the practice pill
    event('g', MIDNIGHT + HOUR, { sessionId: 'practice:p1' }),
    event('h', MIDNIGHT + HOUR, { taskType: 'quick', sessionId: undefined }), // a Got it
    event('i', localDayStart(NOW, 1)), // stamped tomorrow
    event('j', MIDNIGHT + HOUR, { itemType: 'vocab' }), // a word, triaged while Today still took words
    event('k', MIDNIGHT + HOUR, { itemType: 'phrase' }),
  ];
  assert.equal(todaySetCount(history(recent), NOW), 3);
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

test('the progress line counts what you can say (and this week\'s), practice, tomorrow\'s practice and this week\'s saved sentences', () => {
  const line = (id: string, options: Parameters<typeof sentenceItem>[2] = {}) => sentenceItem(id, `A line called ${id}.`, options);
  const items = [
    line('say-old', { srs: sayable(NOW - 30 * DAY) }),
    line('say-new', { srs: sayable(localDayStart(NOW, -6)) }),
    line('due', { srs: practicing(NOW - 9 * DAY, { nextReview: NOW - HOUR, lastReviewDate: MIDNIGHT - DAY }) }),
    line('done-today', { srs: practicing(NOW - 9 * DAY, { nextReview: NOW + DAY, lastReviewDate: MIDNIGHT + HOUR }) }),
    line('later', { srs: practicing(NOW - 9 * DAY, { nextReview: localDayStart(NOW, 2), lastReviewDate: MIDNIGHT - DAY }) }),
    line('passive', { srs: passive(NOW - DAY) }),
    line('got-it', { srs: reviewed(NOW - DAY) }),
    line('saved', { savedAt: localDayStart(NOW, -6) }),
    line('saved-earlier', { savedAt: localDayStart(NOW, -7) }),
    line('untranslated', { translation: null, savedAt: NOW - HOUR }),
    vocabItem('word', 'saved this week', { savedAt: NOW - HOUR }),
    vocabItem('word-practicing', 'from before', { srs: practicing(NOW - 9 * DAY, { nextReview: NOW - HOUR, lastReviewDate: MIDNIGHT - DAY }) }),
    vocabItem('word-sayable', 'from before', { srs: sayable(NOW - DAY) }),
    sentenceItem('real-life-sentence:x:y:01', 'Line.', { catalogKind: 'real-life', catalogSentenceId: 'x:y:01', catalogCollectionId: 'x', savedAt: NOW }),
    line('gone', { isDeleted: true, savedAt: NOW, srs: sayable(NOW) }),
    line('kept', { isArchived: true, savedAt: NOW, srs: practicing(NOW, { nextReview: NOW - 1, lastReviewDate: MIDNIGHT - DAY }) }),
  ];
  assert.deepEqual(loopProgress(items, NOW), {
    sayable: 2, sayableThisWeek: 1, practicing: 3, practiceDue: 1, tomorrow: 2, savedThisWeek: 2,
  });
});

test('sorted this week counts each sentence decided by a triage, in a set or with the pill, over today and the six days before', () => {
  const weekStart = localDayStart(NOW, -6);
  const recent = [
    event('a', weekStart), event('a', NOW), event('b', NOW, { sessionId: undefined }),
    event('c', weekStart - 1), event('d', NOW, { previousStep: 2, nextStep: 3 }), event('e', NOW, { taskType: 'quick', sessionId: undefined }),
    event('w', NOW, { itemType: 'vocab' }), event('wp', NOW, { itemType: 'vocab', sessionId: undefined }),
  ];
  assert.equal(sortedThisWeek(history(recent), NOW), 3, 'a, b, and d, which had two reviews before; never a word');
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

test('the practice count next changes when a sentence not reviewed today falls due, or at midnight', () => {
  const tonight = localDayStart(NOW, 1);
  const item = (id: string, nextReview: number, lastReviewDate = MIDNIGHT - DAY) =>
    sentenceItem(id, `Practicing ${id}.`, { srs: practicing(NOW - 9 * DAY, { nextReview, lastReviewDate }) });
  assert.equal(nextPracticeClockChange([], NOW), tonight);
  assert.equal(nextPracticeClockChange([item('a', NOW + 2 * HOUR), item('b', NOW + HOUR)], NOW), NOW + HOUR);
  // Already due, due after midnight, reviewed today (its 10-minute step), or not in practice: nothing before midnight.
  const unchanged = [
    item('due', NOW - HOUR),
    item('later', tonight + HOUR),
    item('today', NOW + 10 * 60_000, MIDNIGHT + HOUR),
    sentenceItem('passive', 'Kept passive.', { srs: passive(MIDNIGHT - DAY, { nextReview: NOW + HOUR }) }),
    sentenceItem('got-it', 'Got it.', { srs: reviewed(MIDNIGHT - DAY, { nextReview: NOW + HOUR }) }),
    vocabItem('word', 'from before', { srs: practicing(NOW - 9 * DAY, { nextReview: NOW + HOUR, lastReviewDate: MIDNIGHT - DAY }) }),
    { ...item('kept', NOW + HOUR), isArchived: true },
  ];
  assert.equal(nextPracticeClockChange(unchanged, NOW), tonight);
});
