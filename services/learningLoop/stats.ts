import type { ReviewHistory, StoredItem } from '../../types';
import type { SetDaysResponse } from '../../server/src/shared/review';
import { PRACTICE_SESSION_CAP } from './session';
import { isLoopEligible, isOwnSentence, isPracticeDue, itemStanding, localDayKey, localDayStart } from './standing';

// Today's numbers: the day's goal and the streak of days that met it, the progress line under the plan, and what the
// plan's one primary button offers. Pure; the Today screen passes the library, the review history (the server's recent
// reviews merged with this device's outbox, as useReviewHistory holds it) and the set days the server counted.

/**
 * New items to meet in sets each day: one set. The owner's minimum is a set a day, and the planner never splits a theme
 * into sets smaller than this (planner.ts setSize), so any one of its sets meets the goal.
 */
export const DAILY_SET_GOAL = 12;
/** From this many practice items due, the plan puts practice first and the set row says so (the load governor). */
export const PRACTICE_FIRST_AT = 40;
/** How far back a streak can reach: as far as the set-days endpoint counts. */
const STREAK_DAYS = 400;

/**
 * Today's count toward the goal: the distinct items first met in a set since local midnight, from the triage reviews
 * of set sessions on items never reviewed before. A choice taken back with Back left the history, so it doesn't count.
 */
export function todaySetCount(history: ReviewHistory, now: number): number {
  const from = localDayStart(now);
  const until = localDayStart(now, 1);
  const met = new Set<string>();
  for (const event of history.recent) {
    if (event.taskType === 'triage' && event.previousStep === 0 && event.sessionId?.startsWith('set:') &&
      event.reviewedAt >= from && event.reviewedAt < until) met.add(event.itemId);
  }
  return met.size;
}

/**
 * The streak: consecutive local days that met the goal, counting back from yesterday through the server's set days,
 * plus today once it is met (an unmet today doesn't break it yet). The server buckets days with this device's offset
 * from UTC now, so across a daylight-saving change an item met in the hour before midnight may count for the next day.
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

/** The progress line's numbers and today's practice load, from one pass over the library. */
export interface LoopProgress {
  /** Items you can say. */
  sayable: number;
  /** Of them, marked or graduated this week (today and the six days before). */
  sayableThisWeek: number;
  practicing: number;
  /** Practice items due today (standing.ts isPracticeDue). */
  practiceDue: number;
  /** Practice items due by the end of tomorrow: tomorrow's practice, if today's is done. */
  tomorrow: number;
  /** Words and own sentences saved this week. */
  savedThisWeek: number;
}

export function loopProgress(items: readonly StoredItem[], now: number): LoopProgress {
  const todayStart = localDayStart(now);
  const weekStart = localDayStart(now, -6);
  const tomorrowEnd = localDayStart(now, 2);
  const progress: LoopProgress = { sayable: 0, sayableThisWeek: 0, practicing: 0, practiceDue: 0, tomorrow: 0, savedThisWeek: 0 };
  for (const item of items) {
    if (!item.isDeleted && !item.isArchived && (item.type === 'vocab' || isOwnSentence(item)) && (item.savedAt || 0) >= weekStart) {
      progress.savedThisWeek++;
    }
    if (!isLoopEligible(item)) continue;
    const standing = itemStanding(item);
    if (standing === 'sayable') {
      progress.sayable++;
      if ((item.srs.sayableAt ?? 0) >= weekStart) progress.sayableThisWeek++;
    } else if (standing === 'practicing') {
      progress.practicing++;
      if (isPracticeDue(item, now, todayStart)) progress.practiceDue++;
      if ((item.srs?.nextReview ?? 0) < tomorrowEnd) progress.tomorrow++;
    }
  }
  return progress;
}

/**
 * When today's practice count next changes with the clock alone: when the first practice item not reviewed today falls
 * due, or at the next local midnight, when the items reviewed today wait no longer. Today re-plans then, and the tab's
 * badge counts again.
 */
export function nextPracticeClockChange(items: readonly StoredItem[], now: number): number {
  const todayStart = localDayStart(now);
  let next = localDayStart(now, 1);
  for (const item of items) {
    const srs = item.srs;
    if (!srs || srs.nextReview <= now || srs.nextReview >= next || (srs.lastReviewDate ?? 0) >= todayStart) continue;
    if (isLoopEligible(item) && itemStanding(item) === 'practicing') next = srs.nextReview;
  }
  return next;
}

/** "Sorted" this week: the distinct items given their first review by a triage choice, in a set or with the toggle. */
export function sortedThisWeek(history: ReviewHistory, now: number): number {
  const weekStart = localDayStart(now, -6);
  const sorted = new Set<string>();
  for (const event of history.recent) {
    if (event.taskType === 'triage' && event.previousStep === 0 && event.reviewedAt >= weekStart) sorted.add(event.itemId);
  }
  return sorted.size;
}

/** Done for today: the goal met and no practice due. */
export const isDoneForToday = (todayCount: number, practiceDue: number): boolean =>
  todayCount >= DAILY_SET_GOAL && practiceDue === 0;

/** The load governor: so much practice is due that the plan offers practice before any set. */
export const isPracticeFirst = (practiceDue: number): boolean => practiceDue >= PRACTICE_FIRST_AT;

/**
 * What the plan's one primary button offers next: practice while any is due (a session of at most 30), then a set
 * until the goal is met, then done. 'no-set' when the goal isn't met and no set can be offered: the themes are still
 * being sorted, or no theme has a new item left.
 */
export type TodayAction = { kind: 'practice'; count: number } | { kind: 'set' } | { kind: 'no-set' } | { kind: 'done' };

export function todayAction(practiceDue: number, todayCount: number, hasSet: boolean): TodayAction {
  if (practiceDue > 0) return { kind: 'practice', count: Math.min(practiceDue, PRACTICE_SESSION_CAP) };
  if (todayCount >= DAILY_SET_GOAL) return { kind: 'done' };
  return hasSet ? { kind: 'set' } : { kind: 'no-set' };
}
