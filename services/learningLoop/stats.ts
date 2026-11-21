import type { ReviewEvent, ReviewHistory } from '../../types';
import type { SetDaysResponse } from '../../server/src/shared/review';
import { localDayKey, localDayStart } from './standing';

// Today's numbers: the day's goal and the streak of days that met it. Pure; the Today screen passes the review history
// (the server's recent reviews merged with this device's outbox, as useReviewHistory holds it) and the set days the
// server counted.

/**
 * Sentences to Got it in units each day: one unit's worth. The planner never makes a unit smaller than this (planner.ts
 * setSize), so finishing any one unit meets the goal.
 */
export const DAILY_SET_GOAL = 12;
/** How far back a streak can reach: as far as the set-days endpoint counts. */
const STREAK_DAYS = 400;

/**
 * Today's count toward the goal: the distinct sentences reviewed in a unit since local midnight. A unit's lesson records
 * each Got it as a 'quick' review in the unit's session ('set:<unit id>'); a 'triage' in a set's session is what a v3
 * set recorded, and counts too. Only sentences count, never a word, and neither does a review outside a unit, a Got it
 * on the Sentences tab included. A review taken back left the history, so it doesn't count.
 */
export function todaySetCount(history: ReviewHistory, now: number): number {
  const from = localDayStart(now);
  const until = localDayStart(now, 1);
  const met = new Set<string>();
  for (const event of history.recent) {
    if (countsTowardGoal(event) && event.reviewedAt >= from && event.reviewedAt < until) met.add(event.itemId);
  }
  return met.size;
}

/** Whether a review counts toward its day's goal, as the server's set days count it too: see todaySetCount. */
function countsTowardGoal(event: ReviewEvent): boolean {
  return (event.taskType === 'quick' || event.taskType === 'triage') && event.itemType === 'sentence' &&
    !!event.sessionId?.startsWith('set:');
}

/**
 * The server's set days with what the recent history shows (the last eight days, this device's unsent reviews
 * included), the larger count on each day. The history's reviews are bucketed as the server buckets them, by today's
 * offset from UTC, so the two always agree on a review's day, across a daylight-saving change too, and taking the
 * larger never counts one review on two days. So a day this device knows met the goal keeps the streak where the
 * server's count falls short of it: a review still in the outbox when the set days loaded (they load once a day), or a
 * server counting by an older rule, as during a rollback to v3, whose set days take only triage. Where the history is
 * the one short (another device's reviews since it loaded, a review whose time the server moved later), the server's
 * count stands. A review undone after the set days loaded counts until they load again the next day; a unit's Got it
 * has no undo.
 */
export function withRecentSetDays(setDays: SetDaysResponse['days'], history: ReviewHistory, now: number): SetDaysResponse['days'] {
  const offsetMs = -new Date(now).getTimezoneOffset() * 60_000;
  const perDay = new Map<string, Set<string>>();
  for (const event of history.recent) {
    if (!countsTowardGoal(event)) continue;
    const key = new Date(event.reviewedAt + offsetMs).toISOString().slice(0, 10);
    const met = perDay.get(key) ?? new Set<string>();
    met.add(event.itemId);
    perDay.set(key, met);
  }
  if (perDay.size === 0) return setDays;
  const merged: SetDaysResponse['days'] = { ...setDays };
  for (const [key, met] of perDay) merged[key] = Math.max(Object.hasOwn(setDays, key) ? setDays[key] : 0, met.size);
  return merged;
}

/**
 * The streak: consecutive local days that met the goal, counting back from yesterday through the server's set days,
 * plus today once it is met (an unmet today doesn't break it yet). The server buckets days with this device's offset
 * from UTC now, so across a daylight-saving change a sentence met in the hour before midnight may count for the next
 * day.
 */
export function loopStreak(setDays: SetDaysResponse['days'], todayCount: number, now: number): number {
  let streak = 0;
  for (let back = 1; back <= STREAK_DAYS; back++) {
    const key = localDayKey(localDayStart(now, -back));
    if (!(Object.hasOwn(setDays, key) && setDays[key] >= DAILY_SET_GOAL)) break;
    streak++;
  }
  return streak + (todayCount >= DAILY_SET_GOAL ? 1 : 0);
}

/**
 * The set days for the streak, loaded at most once per local day (and per offset from UTC, which daylight saving or
 * travel changes) and kept in memory; a failed load isn't kept, so the next call tries again. `load` is
 * services/api/learningLoop.ts loadSetDays.
 */
export function setDaysLoader(load: (tzOffsetMinutes: number) => Promise<SetDaysResponse>): (now: number) => Promise<SetDaysResponse['days']> {
  let cached: { key: string; days: Promise<SetDaysResponse['days']> } | null = null;
  return now => {
    const offset = -new Date(now).getTimezoneOffset();
    const key = `${localDayKey(now)} ${offset}`;
    if (cached?.key === key) return cached.days;
    const days = load(offset).then(response => response.days);
    const entry = { key, days };
    cached = entry;
    days.catch(() => { if (cached === entry) cached = null; });
    return days;
  };
}
