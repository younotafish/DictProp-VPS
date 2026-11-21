import type { ReviewEvent, ReviewHistory } from '../../types';
import type { SetDaysResponse } from '../../server/src/shared/review';
import { localDayKey, localDayStart } from './standing';

// Today's numbers: the day's goal and the streak of days that met it. Pure but for the device's time zone; the Today
// screen passes the review history (the server's recent reviews merged with this device's outbox, as useReviewHistory
// holds it) and the set days the server counted.

/**
 * Sentences to Got it in units each day: one unit's worth. The planner never splits a theme into units smaller than
 * this (planner.ts setSize), so a unit from a theme with this many or more to review meets the goal on its own; a
 * smaller theme's unit holds all it has, and that theme ranks lower (themeScore).
 */
export const DAILY_SET_GOAL = 12;
/** How far back a streak can reach: as far as the set-days endpoint counts. */
const STREAK_DAYS = 400;

/**
 * Today's count toward the goal: the distinct sentences reviewed in a unit since local midnight. A unit's lesson records
 * each Got it as a 'quick' review in the unit's session ('set:<unit id>'); a 'triage' in a set's session is what a v3
 * set recorded, and counts too. Only sentences count, never a word, and neither does a review outside a unit, a Got it
 * on the Sentences tab included. A review taken back left the history, and so did one the server refused, so neither
 * counts.
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

/** The IANA time zone this device is in ('America/Los_Angeles'), or undefined where the browser doesn't say. */
function deviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server's set days with what the recent history shows (the last eight days, this device's unsent reviews
 * included), the larger count on each day. The history buckets its reviews as the server bucketed its days, so the two
 * always agree on a review's day and taking the larger never counts one review on two days: by local calendar day when
 * the server counted in this device's time zone (SetDaysResponse.timeZone), and otherwise by today's offset from UTC,
 * as an older server, or one that doesn't know the zone, counts (its days put a review made in the hour a
 * daylight-saving change moved on the neighbouring day). So a day this device knows met the goal keeps the streak
 * where the server's count falls short of it: a review still in the outbox when the set days loaded (they load once a
 * day), or a server counting by an older rule, as during a rollback to v3, whose set days take only triage. Where the
 * history is the one short (another device's reviews since it loaded), the server's count stands. Until the history
 * next loads, when it takes the server's reviews afresh, two counts can still be off: one day's reviews split between
 * another device's, on the server, and this device's still in its outbox count as the larger part, not both; and a
 * review the server moved to a later day, because the sentence was reviewed again elsewhere first, counts on its own
 * day too. A review undone after the set days loaded counts until they load again the next day; a unit's Got it has no
 * undo.
 */
export function withRecentSetDays(setDays: SetDaysResponse, history: ReviewHistory, now: number): SetDaysResponse['days'] {
  const offsetMs = -new Date(now).getTimezoneOffset() * 60_000;
  const dayOf = setDays.timeZone !== undefined && setDays.timeZone === deviceTimeZone()
    ? localDayKey
    : (time: number) => new Date(time + offsetMs).toISOString().slice(0, 10);
  const perDay = new Map<string, Set<string>>();
  for (const event of history.recent) {
    if (!countsTowardGoal(event)) continue;
    const key = dayOf(event.reviewedAt);
    const met = perDay.get(key) ?? new Set<string>();
    met.add(event.itemId);
    perDay.set(key, met);
  }
  if (perDay.size === 0) return setDays.days;
  const merged: SetDaysResponse['days'] = { ...setDays.days };
  for (const [key, met] of perDay) merged[key] = Math.max(Object.hasOwn(setDays.days, key) ? setDays.days[key] : 0, met.size);
  return merged;
}

/**
 * The streak: consecutive local days that met the goal, counting back from yesterday through the set days, plus today
 * once it is met (an unmet today doesn't break it yet). Each day is a local calendar day, as today's count is, across
 * a daylight-saving change too; only a trip across time zones can still move a review made near midnight to the day
 * before or after, since every day counts in the zone the device is in now.
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
 * The set days for the streak, loaded at most once per local day, offset from UTC and time zone (daylight saving
 * changes the offset, travel the zone too) and kept in memory; a failed load isn't kept, so the next call tries again.
 * Each load names this device's time zone, so a server that knows it counts the zone's local calendar days. `load` is
 * services/api/learningLoop.ts loadSetDays.
 */
export function setDaysLoader(
  load: (tzOffsetMinutes: number, timeZone?: string) => Promise<SetDaysResponse>,
): (now: number) => Promise<SetDaysResponse> {
  let cached: { key: string; response: Promise<SetDaysResponse> } | null = null;
  return now => {
    const offset = -new Date(now).getTimezoneOffset();
    const zone = deviceTimeZone();
    const key = `${localDayKey(now)} ${offset} ${zone ?? ''}`;
    if (cached?.key === key) return cached.response;
    const response = load(offset, zone);
    const entry = { key, response };
    cached = entry;
    response.catch(() => { if (cached === entry) cached = null; });
    return response;
  };
}
