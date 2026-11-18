// The review vocabulary the client records and the server stores with every review event.

export const REVIEW_RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export type ReviewRating = typeof REVIEW_RATINGS[number];

/**
 * What a review was. Study's four prompts and the one-tap Got it ('quick'), plus Today's loop:
 * - 'triage': the choice made on meeting a set item, or the practice toggle (again joins practice, good is passive,
 *   easy is "can say it"; services/learningLoop and shared/practice.ts);
 * - 'speak': a practice attempt said aloud;
 * - 'recall': a practice attempt in Quiet mode, thought rather than said.
 */
export const REVIEW_TASK_TYPES = ['meaning', 'production', 'cloze', 'listening', 'quick', 'triage', 'speak', 'recall'] as const;
export type ReviewTaskType = typeof REVIEW_TASK_TYPES[number];

export const isReviewRating = (value: unknown): value is ReviewRating =>
  (REVIEW_RATINGS as readonly unknown[]).includes(value);

export const isReviewTaskType = (value: unknown): value is ReviewTaskType =>
  (REVIEW_TASK_TYPES as readonly unknown[]).includes(value);

/** The ratings Today's task types take; the others take any rating, or none (a legacy client's Good). */
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

/** GET /api/reviews/set-days: per local day ('YYYY-MM-DD' under the asked offset), the items first met in a set. */
export interface SetDaysResponse {
  days: Record<string, number>;
}
