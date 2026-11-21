import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent, ReviewHistory, ReviewTaskType } from '../../types.ts';
import { localDayKey, localDayStart } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL, loopStreak, setDaysLoader, todaySetCount, withRecentSetDays } from '../../services/learningLoop/stats.ts';
import { DAY, HOUR } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const MIDNIGHT = localDayStart(NOW);

let nextEvent = 0;
/** A Got it in the unit 'u1' unless `extra` says otherwise. */
const event = (itemId: string, reviewedAt: number, extra: Partial<ReviewEvent> & { taskType?: ReviewTaskType } = {}): ReviewEvent => ({
  id: `e${nextEvent++}`, itemId, itemType: 'sentence', reviewedAt, previousStep: 0, nextStep: 1, rating: 'good',
  taskType: 'quick', sessionId: 'set:u1', ...extra,
});
const history = (recent: ReviewEvent[]): ReviewHistory => ({ recent, olderTimes: [], olderCount: 0 });

test('the day\'s goal is one unit\'s worth: twelve sentences, as no unit is smaller', () => {
  assert.equal(DAILY_SET_GOAL, 12);
});

test('today\'s count is the distinct sentences Got it\'d in a unit since local midnight, and the triage of a v3 set', () => {
  const recent = [
    event('a', MIDNIGHT + HOUR),
    event('a', MIDNIGHT + 2 * HOUR, { previousStep: 1, nextStep: 2 }), // Got it again in the same unit: still one
    event('b', NOW, { sessionId: 'set:u2' }), // another unit
    event('c', MIDNIGHT + HOUR, { previousStep: 3, nextStep: 4 }), // Got it'd three times on the Sentences tab before
    event('d', MIDNIGHT + HOUR, { taskType: 'triage', rating: 'again' }), // a v3 set's Meet, sent from its outbox
    event('e', MIDNIGHT - 1), // yesterday
    event('f', localDayStart(NOW, 1)), // stamped tomorrow
    event('g', MIDNIGHT + HOUR, { sessionId: undefined }), // a Got it on the Sentences tab
    event('h', MIDNIGHT + HOUR, { sessionId: 'practice:p1' }), // a v3 practice session
    event('i', MIDNIGHT + HOUR, { sessionId: 'c5d0e8a1-study', taskType: 'meaning' }), // Card review's session
    event('j', MIDNIGHT + HOUR, { taskType: 'speak' }), // a v3 set's round
    event('k', MIDNIGHT + HOUR, { taskType: 'recall' }),
    event('l', MIDNIGHT + HOUR, { itemType: 'vocab' }), // a word
    event('m', MIDNIGHT + HOUR, { itemType: 'phrase', taskType: 'triage' }),
  ];
  assert.equal(todaySetCount(history(recent), NOW), 4, 'a, b, c and d');
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

test('the recent history adds to the server\'s set days, the larger count each day, and never takes from them', () => {
  const day = (back: number) => localDayKey(localDayStart(NOW, -back));
  const yesterday = localDayStart(NOW, -1) + 10 * HOUR;
  const unit = Array.from({ length: DAILY_SET_GOAL }, (_, index) => event(`s${index}`, yesterday));
  // A server rolled back to v3 counts only triage, so its set days miss yesterday's unit.
  const rolledBack = { [day(2)]: 12 };
  assert.equal(loopStreak(rolledBack, 0, NOW), 0);
  const merged = withRecentSetDays(rolledBack, history(unit), NOW);
  assert.deepEqual(merged, { [day(2)]: 12, [day(1)]: 12 });
  assert.equal(loopStreak(merged, 0, NOW), 2);

  // What doesn't count toward the goal adds nothing, and the same sentence twice is one.
  const noise = [
    event('w', yesterday, { itemType: 'vocab' }),
    event('x', yesterday, { sessionId: undefined }),
    event('y', yesterday, { taskType: 'speak' }),
    event('s0', yesterday + HOUR),
  ];
  assert.deepEqual(withRecentSetDays({}, history([...unit, ...noise]), NOW), { [day(1)]: 12 });
  // Where the history is the one short, as when another device reviewed after it loaded, the server's count stands.
  assert.deepEqual(withRecentSetDays({ [day(1)]: 30 }, history(noise), NOW), { [day(1)]: 30 });
  const kept = { [day(1)]: 5 };
  assert.equal(withRecentSetDays(kept, history([]), NOW), kept, 'with nothing to add, the server\'s days as they are');
});

test('the history buckets reviews as the server does, so across a daylight-saving change none counts on two days', () => {
  const saved = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // New York falls back at 2:00 on 2026-11-01. On the 3rd the server buckets with today's offset, UTC-5, so a review
    // made at 00:30 on Nov 1, still UTC-4, reads as Oct 31 there. The history buckets it the same way.
    const now = new Date(2026, 10, 3, 12).getTime();
    const earlyNov1 = new Date(2026, 10, 1, 0, 30).getTime();
    const unit = Array.from({ length: DAILY_SET_GOAL }, (_, index) => event(`d${index}`, earlyNov1 + index * 60_000));
    const merged = withRecentSetDays({ '2026-10-31': 12 }, history(unit), now);
    assert.deepEqual(merged, { '2026-10-31': 12 }, 'one day, as the server counted it, not Nov 1 as well');
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
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
