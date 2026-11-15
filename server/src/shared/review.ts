// The review vocabulary the client records and the server stores with every review event.

export const REVIEW_RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export type ReviewRating = typeof REVIEW_RATINGS[number];

export const REVIEW_TASK_TYPES = ['meaning', 'production', 'cloze', 'listening', 'quick'] as const;
export type ReviewTaskType = typeof REVIEW_TASK_TYPES[number];

export const isReviewRating = (value: unknown): value is ReviewRating =>
  (REVIEW_RATINGS as readonly unknown[]).includes(value);

export const isReviewTaskType = (value: unknown): value is ReviewTaskType =>
  (REVIEW_TASK_TYPES as readonly unknown[]).includes(value);
