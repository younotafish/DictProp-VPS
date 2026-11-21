import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent, ReviewHistory, ReviewTaskType } from '../../types.ts';
import { localDayKey, localDayStart } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL, loopStreak, setDaysLoader, todaySetCount } from '../../services/learningLoop/stats.ts';
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
