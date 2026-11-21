import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent, ReviewHistory, ReviewTaskType } from '../../types.ts';
import type { SetDaysResponse } from '../../server/src/shared/review.ts';
import { loadSetDays } from '../../services/api/learningLoop.ts';
import { localDayKey, localDayStart } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL, loopStreak, setDaysKey, setDaysLoader, todaySetCount, withRecentSetDays } from '../../services/learningLoop/stats.ts';
import { DAY, HOUR } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const MIDNIGHT = localDayStart(NOW);
/** The time zone the tests run in, which a server that knows it names in its set days. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const LOS_ANGELES = 'America/Los_Angeles';

let nextEvent = 0;
/** A Got it in the unit 'u1' unless `extra` says otherwise. */
const event = (itemId: string, reviewedAt: number, extra: Partial<ReviewEvent> & { taskType?: ReviewTaskType } = {}): ReviewEvent => ({
  id: `e${nextEvent++}`, itemId, itemType: 'sentence', reviewedAt, previousStep: 0, nextStep: 1, rating: 'good',
  taskType: 'quick', sessionId: 'set:u1', ...extra,
});
const history = (recent: ReviewEvent[]): ReviewHistory => ({ recent, olderTimes: [], olderCount: 0 });
/** Twelve Got its in the unit 'u1', a minute apart from `from`: a day's goal. */
const unitFrom = (from: number, prefix = 's'): ReviewEvent[] =>
  Array.from({ length: DAILY_SET_GOAL }, (_, index) => event(`${prefix}${index}`, from + index * 60_000));

/** Runs `body` on a device in the time zone `zone`, as the browser reports it to Date and to Intl alike. */
async function inZone(zone: string, body: () => void | Promise<void>): Promise<void> {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

test('the day\'s goal is one unit\'s worth: twelve sentences, as no theme is split into smaller units', () => {
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
  const unit = unitFrom(yesterday);
  // A server rolled back to v3 counts only triage, so its set days miss yesterday's unit.
  const rolledBack = { [day(2)]: 12 };
  assert.equal(loopStreak(rolledBack, 0, NOW), 0);
  const merged = withRecentSetDays({ days: rolledBack }, history(unit), NOW);
  assert.deepEqual(merged, { [day(2)]: 12, [day(1)]: 12 });
  assert.equal(loopStreak(merged, 0, NOW), 2);

  // What doesn't count toward the goal adds nothing, and the same sentence twice is one.
  const noise = [
    event('w', yesterday, { itemType: 'vocab' }),
    event('x', yesterday, { sessionId: undefined }),
    event('y', yesterday, { taskType: 'speak' }),
    event('s0', yesterday + HOUR),
  ];
  assert.deepEqual(withRecentSetDays({ days: {}, timeZone: ZONE }, history([...unit, ...noise]), NOW), { [day(1)]: 12 });
  // Where the history is the one short, as when another device reviewed after it loaded, the server's count stands.
  assert.deepEqual(withRecentSetDays({ days: { [day(1)]: 30 }, timeZone: ZONE }, history(noise), NOW), { [day(1)]: 30 });
  const kept = { [day(1)]: 5 };
  assert.equal(withRecentSetDays({ days: kept, timeZone: ZONE }, history([]), NOW), kept, 'with nothing to add, the server\'s days as they are');
});

test('a review stamped past the times a Date can name a day for counts on no day, and the rest still count', () => {
  // Only a corrupted last review date stamps one there, since the server never stamps a review before the last.
  const day = (back: number) => localDayKey(localDayStart(NOW, -back));
  const recent = [...unitFrom(localDayStart(NOW, -1) + 10 * HOUR), event('far', 1e17), event('far-back', -1e17)];
  assert.deepEqual(withRecentSetDays({ days: {} }, history(recent), NOW), { [day(1)]: 12 }, 'under today\'s offset');
  assert.deepEqual(withRecentSetDays({ days: {}, timeZone: ZONE }, history(recent), NOW), { [day(1)]: 12 }, 'by calendar day');
});

test('in the device\'s zone a review counts on the local day it was made, so the night clocks fall back counts once', async () => {
  await inZone(LOS_ANGELES, () => {
    // Los Angeles falls back at 2:00 on 2026-11-01. A unit done at 00:30 that night, still on daylight time, belongs to
    // Nov 1 alone, and the server, asked in the zone, counts it there.
    const night = history(unitFrom(new Date(2026, 10, 1, 0, 30).getTime()));
    const server: SetDaysResponse = { days: { '2026-11-01': 12 }, timeZone: LOS_ANGELES };
    const streakAt = (now: number) => loopStreak(withRecentSetDays(server, night, now), todaySetCount(night, now), now);

    const sundayMorning = new Date(2026, 10, 1, 10).getTime(); // standard time by then
    assert.equal(todaySetCount(night, sundayMorning), DAILY_SET_GOAL);
    assert.equal(streakAt(sundayMorning), 1, 'today\'s unit, not counted for Oct 31 as well');
    assert.equal(streakAt(new Date(2026, 10, 2, 12).getTime()), 1, 'on Monday, Sunday met the goal');
    // From the history alone, as for reviews still in the outbox when the set days loaded, it goes to Nov 1 only.
    assert.deepEqual(withRecentSetDays({ days: {}, timeZone: LOS_ANGELES }, night, new Date(2026, 10, 2, 12).getTime()), { '2026-11-01': 12 });
  });
});

test('in the device\'s zone a unit done the night before clocks spring forward counts for that night\'s day', async () => {
  await inZone(LOS_ANGELES, () => {
    // Los Angeles springs forward at 2:00 on 2026-03-08. A unit done at 23:30 on the 7th, standard time, belongs to the
    // 7th: Sunday's streak holds it, and Monday's, with Sunday missed, is broken.
    const night = history(unitFrom(new Date(2026, 2, 7, 23, 30).getTime()));
    const server: SetDaysResponse = { days: { '2026-03-07': 12 }, timeZone: LOS_ANGELES };
    const streakAt = (now: number) => loopStreak(withRecentSetDays(server, night, now), todaySetCount(night, now), now);

    const sunday = new Date(2026, 2, 8, 12).getTime();
    assert.equal(todaySetCount(night, sunday), 0);
    assert.equal(streakAt(sunday), 1);
    assert.deepEqual(withRecentSetDays({ days: {}, timeZone: LOS_ANGELES }, night, sunday), { '2026-03-07': 12 });
    assert.equal(streakAt(new Date(2026, 2, 9, 12).getTime()), 0);
  });
});

test('set days counted by offset alone, as an older server counts them, find the history bucketed the same way', async () => {
  await inZone('America/New_York', () => {
    // New York falls back at 2:00 on 2026-11-01. On the 3rd a server without the zone buckets with today's offset,
    // UTC-5, so a review made at 00:30 on Nov 1, still UTC-4, reads as Oct 31 there. The history buckets it the same
    // way, so no review counts on two days.
    const now = new Date(2026, 10, 3, 12).getTime();
    const night = history(unitFrom(new Date(2026, 10, 1, 0, 30).getTime(), 'd'));
    assert.deepEqual(withRecentSetDays({ days: { '2026-10-31': 12 } }, night, now), { '2026-10-31': 12 }, 'one day, as the server counted it, not Nov 1 as well');
    // So does a server that counted in a zone this device has left since the set days loaded.
    assert.deepEqual(withRecentSetDays({ days: { '2026-10-31': 12 }, timeZone: 'America/Chicago' }, night, now), { '2026-10-31': 12 });
    // In this device's zone it is a Nov 1 review.
    assert.deepEqual(withRecentSetDays({ days: {}, timeZone: 'America/New_York' }, night, now), { '2026-11-01': 12 });
  });
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

test('the set days load once a day, offset and time zone, naming the device\'s zone, and a failed load is tried again', async () => {
  await inZone(LOS_ANGELES, async () => {
    const loads: [number, string | undefined][] = [];
    let fail = true;
    const answer: SetDaysResponse = { days: { '2026-01-14': 15 }, timeZone: LOS_ANGELES };
    const load = setDaysLoader(async (offset, zone) => {
      loads.push([offset, zone]);
      if (fail) throw new Error('offline');
      return answer;
    });
    const now = new Date(2026, 0, 15, 15).getTime();
    await assert.rejects(load(now), /offline/);
    fail = false;
    assert.equal(await load(now), answer, 'the failure wasn\'t kept, and the answer comes whole, with its zone');
    assert.equal(await load(now + HOUR), answer);
    assert.equal(loads.length, 2, 'the same day loads once');
    await load(now + DAY);
    assert.deepEqual(loads, [[-480, LOS_ANGELES], [-480, LOS_ANGELES], [-480, LOS_ANGELES]], 'a new day loads again');

    // Vancouver keeps Los Angeles's offset and day, but its days are its own: a device that moves there loads again.
    process.env.TZ = 'America/Vancouver';
    await load(now + DAY);
    assert.deepEqual(loads.slice(3), [[-480, 'America/Vancouver']]);
  });
});

test('a set days\' answer is asked for under the day, the offset from UTC and the time zone, and only those', async () => {
  await inZone(LOS_ANGELES, () => {
    const now = new Date(2026, 0, 15, 15).getTime();
    assert.equal(setDaysKey(now), `2026-01-15 -480 ${LOS_ANGELES}`);
    assert.equal(setDaysKey(now + HOUR), setDaysKey(now), 'later the same day');
    assert.equal(setDaysKey(now + DAY), `2026-01-16 -480 ${LOS_ANGELES}`);
    assert.equal(setDaysKey(new Date(2026, 6, 15, 15).getTime()), `2026-07-15 -420 ${LOS_ANGELES}`, 'summer time');
    // Vancouver keeps Los Angeles's day and offset, but counts its own days.
    process.env.TZ = 'America/Vancouver';
    assert.equal(setDaysKey(now), '2026-01-15 -480 America/Vancouver');
  });
});

test('the set days\' request names the device\'s zone, and only the offset when it has none', async t => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return Response.json({ days: {} });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await loadSetDays(-480, LOS_ANGELES);
  await loadSetDays(330.4);
  assert.deepEqual(asked, ['/api/reviews/set-days?tzOffset=-480&tz=America%2FLos_Angeles', '/api/reviews/set-days?tzOffset=330']);
});
