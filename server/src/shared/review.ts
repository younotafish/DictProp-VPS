// The review vocabulary the client records and the server stores with every review event.

export const REVIEW_RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export type ReviewRating = typeof REVIEW_RATINGS[number];

/**
 * What a review was: Study's four prompts and the one-tap Got it ('quick'), which is also what a Got it in one of
 * Today's units records, in the unit's 'set:' session. The loop's three types are what Today recorded before its units;
 * they stay accepted because an outbox may still hold reviews an older build queued, and the server still applies their
 * practice membership (shared/practice.ts), which the app no longer acts on:
 * - 'triage': the choice made on meeting a set's sentence, or with the practice pill (again joins practice, good is
 *   passive, easy is "can say it");
 * - 'speak': a practice attempt said aloud;
 * - 'recall': a practice attempt in Quiet mode, thought rather than said.
 */
export const REVIEW_TASK_TYPES = ['meaning', 'production', 'cloze', 'listening', 'quick', 'triage', 'speak', 'recall'] as const;
export type ReviewTaskType = typeof REVIEW_TASK_TYPES[number];

export const isReviewRating = (value: unknown): value is ReviewRating =>
  (REVIEW_RATINGS as readonly unknown[]).includes(value);

export const isReviewTaskType = (value: unknown): value is ReviewTaskType =>
  (REVIEW_TASK_TYPES as readonly unknown[]).includes(value);

/**
 * The ratings the loop's task types take, the ones their buttons gave; the others take any rating, or none (a legacy
 * client's Good).
 */
const LOOP_TASK_RATINGS: Partial<Record<ReviewTaskType, readonly ReviewRating[]>> = {
  triage: ['again', 'good', 'easy'],
  speak: ['again', 'hard', 'good'],
  recall: ['again', 'hard', 'good'],
};

/** Whether a review may pair this task type with this rating. A loop task type always names its rating. */
export const isRatingAllowedForTask = (taskType: ReviewTaskType | undefined, rating: ReviewRating | undefined): boolean => {
  const allowed = taskType === undefined ? undefined : LOOP_TASK_RATINGS[taskType];
  return allowed === undefined || (rating !== undefined && allowed.includes(rating));
};

/**
 * GET /api/reviews/set-days: per local day ('YYYY-MM-DD', a calendar day in the asked zone or a date under the asked
 * offset), the distinct sentences Got it'd in Today's units: 'quick' reviews of sentences in 'set:' sessions, not
 * undone. A 'triage' review there, a choice made in a set before units, counts too, so the streak keeps the days that
 * sets met.
 */
export interface SetDaysResponse {
  days: Record<string, number>;
  /**
   * The IANA time zone the days are local calendar days of, when the request named one the server knows (`tz`),
   * spelled exactly as the request spelled it, so a client finds its own zone by comparing names; absent when the days
   * are bucketed by the request's fixed offset from UTC (`tzOffset`) alone, as for an older client or server.
   */
  timeZone?: string;
}
