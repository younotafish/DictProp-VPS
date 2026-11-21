// The practice membership Today's loop kept before units: which items were in practice and which could be said. It
// rides on the item's schedule (three optional fields of srs) and changes only inside a review, so it is applied in the
// same step as FSRS on both sides: the server's review apply (db/reviews.ts, inside its transaction) and the
// client's optimistic copy (services/fsrsScheduler.ts). test/contracts/srs.test.ts runs the same task-typed reviews
// through both. Today's units record Got it ('quick'), which leaves membership alone, and the app no longer acts on
// it. The server still applies it because an outbox may hold the loop's reviews that an older build queued, and the
// client's copy stays in step.
//
// The rules:
// - a triage review records the decision the loop asked for on meeting an item in one of its sets, or made with the
//   practice pill: rated again, it joins practice; rated easy, it marks the item one you can say; rated good, it keeps
//   the item passive. Each stamps practiceChangedAt, which is how the loop kept an item decided once, passive included,
//   out of its sets;
// - a practice attempt said aloud ('speak') rated good graduates the item to "can say it" once the schedule is solid:
//   in review (not relearning), stability at least GRADUATION_STABILITY_DAYS, and at least GRADUATION_MIN_GAP_DAYS
//   since the review before it. Nothing else graduates: a Got it, a classic Study grade or a Quiet ('recall') attempt
//   only schedules;
// - a review made before the item's last membership change (a device that was offline) schedules but leaves
//   membership alone, so a stale decision can't undo a newer one.
// Every membership change is a review, which advances lastReviewDate, so schedule merges order membership correctly.

/** Days of FSRS stability a practice item needs before an unaided spoken success graduates it. */
export const GRADUATION_STABILITY_DAYS = 21;
/** Days since the previous review that the graduating success must come after. */
export const GRADUATION_MIN_GAP_DAYS = 14;

const DAY_MS = 86_400_000;
/** ts-fsrs State.Review. */
const FSRS_STATE_REVIEW = 2;

/** The schedule fields practice membership reads and writes. All times are epoch milliseconds. */
export interface PracticeSrs {
  /** Present while the item is in practice: when it joined. */
  practiceSince?: number;
  /** Present once the item is one you can say: when that was decided or earned. */
  sayableAt?: number;
  /** When membership last changed; a review older than this leaves membership alone. */
  practiceChangedAt?: number;
  stability?: number;
  fsrsState?: number;
  lastReviewDate?: number;
}

/** What a review does to membership: join practice, mark sayable, keep passive (a decision, out of practice), or nothing. */
export type PracticeTransition = 'join' | 'sayable' | 'passive' | 'none';

/**
 * The membership change a review makes. `previous` is the schedule before the review, `next` the scheduler's result
 * for it; `eventTime` is when the review was made, `appliedAt` the time its schedule is stamped with.
 */
export function practiceTransition(
  previous: PracticeSrs,
  next: PracticeSrs,
  taskType: string | undefined,
  rating: string | undefined,
  eventTime: number,
  appliedAt: number,
): PracticeTransition {
  if ((previous.practiceChangedAt ?? 0) > eventTime) return 'none';
  if (taskType === 'triage') {
    if (rating === 'again') return 'join';
    if (rating === 'easy') return 'sayable';
    if (rating === 'good') return 'passive';
    return 'none';
  }
  if (
    taskType === 'speak' && rating === 'good' && next.practiceSince !== undefined &&
    next.fsrsState === FSRS_STATE_REVIEW && (next.stability ?? 0) >= GRADUATION_STABILITY_DAYS &&
    appliedAt - (previous.lastReviewDate ?? 0) >= GRADUATION_MIN_GAP_DAYS * DAY_MS
  ) {
    return 'sayable';
  }
  return 'none';
}

/**
 * The scheduler's result with the review's membership change applied. Fields are deleted, never set to null or
 * undefined, so a stored schedule never carries an empty membership key.
 */
export function applyPracticeMembership<T extends PracticeSrs>(
  previous: PracticeSrs,
  next: T,
  taskType: string | undefined,
  rating: string | undefined,
  eventTime: number,
  appliedAt: number,
): T {
  const transition = practiceTransition(previous, next, taskType, rating, eventTime, appliedAt);
  if (transition === 'none') return next;
  const result: T = { ...next, practiceChangedAt: appliedAt };
  if (transition === 'join') {
    result.practiceSince = previous.practiceSince ?? appliedAt;
    delete result.sayableAt;
  } else if (transition === 'sayable') {
    result.sayableAt = appliedAt;
    delete result.practiceSince;
  } else {
    delete result.practiceSince;
    delete result.sayableAt;
  }
  return result;
}

/**
 * Where an item stands in the loop Today ran before units, from its schedule alone: practicing, one you can say, kept
 * passive (decided, out of practice), or new to the loop (no decision yet, whatever classic reviews it has had).
 * Today's units don't read it: they take a sentence while it needs review, by its dates alone.
 */
export type LoopStanding = 'new' | 'practicing' | 'sayable' | 'passive';

export function loopStanding(srs: PracticeSrs | undefined): LoopStanding {
  if (srs?.practiceSince !== undefined) return 'practicing';
  if (srs?.sayableAt !== undefined) return 'sayable';
  if (srs?.practiceChangedAt !== undefined) return 'passive';
  return 'new';
}

/**
 * Whether a stored schedule's membership fields are well formed: each absent or a finite time at or after 0, never in
 * practice and sayable at once, and either one with the time it changed, which the stale-event guard reads (the time
 * alone means kept passive). Only applyPracticeMembership writes them, and it always leaves them so.
 */
export function practiceFieldsValid(srs: Record<string, unknown>): boolean {
  for (const key of ['practiceSince', 'sayableAt', 'practiceChangedAt'] as const) {
    if (!(key in srs)) continue;
    const value = srs[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  }
  const practicing = 'practiceSince' in srs;
  const sayable = 'sayableAt' in srs;
  return !(practicing && sayable) && (!(practicing || sayable) || 'practiceChangedAt' in srs);
}
