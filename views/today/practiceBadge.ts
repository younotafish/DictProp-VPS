import type { StoredItem } from '../../types';
import { isLoopEligible, isPracticeDue, itemStanding, localDayStart } from '../../services/learningLoop/standing';

/** What the Today tab's badge shows, and when it must count again. */
export interface PracticeBadge {
  /** The practice items due now: the count services/learningLoop/session.ts practiceQueue gives the plan. */
  due: number;
  /** When that count next changes with the clock alone, as services/learningLoop/stats.ts nextPracticeClockChange
   *  says: when a practice item not reviewed today falls due, or at the next local midnight. */
  changesAt: number;
}

/**
 * The Today tab's badge, in one pass over the library. The tab bar loads with the app's first screen, so it reads the
 * rules from standing.ts alone: going through stats.ts and session.ts would bring the session model and classic
 * Study's session code along with the bar. test/client/today-badge.test.ts holds both numbers to the loop's own.
 */
export function practiceBadge(items: readonly StoredItem[], now: number): PracticeBadge {
  const todayStart = localDayStart(now);
  let changesAt = localDayStart(now, 1);
  let due = 0;
  for (const item of items) {
    if (isPracticeDue(item, now, todayStart)) {
      due++;
      continue;
    }
    const srs = item.srs;
    if (!srs || srs.nextReview <= now || srs.nextReview >= changesAt || (srs.lastReviewDate ?? 0) >= todayStart) continue;
    if (isLoopEligible(item) && itemStanding(item) === 'practicing') changesAt = srs.nextReview;
  }
  return { due, changesAt };
}
