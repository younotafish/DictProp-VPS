/**
 * The server's FSRS v6 step for each review it applies; it decides the schedule every device keeps.
 *
 * MIRRORED in services/fsrsScheduler.ts: the server compiles only its own src/, and the client keeps the scheduler
 * out of its first bundle, so each side holds a copy, and both need ts-fsrs, so neither can live in shared/. KEEP
 * THE SCHEDULER CONFIG, toFsrsCard AND fromFsrsCard IDENTICAL: test/contracts/srs.test.ts runs the same reviews
 * through both copies and compares every schedule field, or each review would visibly jump after the next sync.
 * The practice membership Today's loop kept before units needs no copy: both apply the same import-free step from
 * shared/practice.ts.
 */
import { Rating, State, createEmptyCard, fsrs, type Card, type CardInput, type Grade } from 'ts-fsrs';
import { applyPracticeMembership, type PracticeSrs } from './shared/practice.js';
import type { ReviewRating, ReviewTaskType } from './shared/review.js';

export type { ReviewRating };

/**
 * The fields of a stored schedule that a review reads, the practice membership among them. Rows from the
 * fixed-schedule era lack the FSRS ones.
 */
export interface SrsLike extends PracticeSrs {
  nextReview?: number;
  interval?: number;
  lastReviewDate?: number;
  totalReviews?: number;
  correctStreak?: number;
  stability?: number;
  difficulty?: number;
  scheduledDays?: number;
  learningSteps?: number;
  lapses?: number;
  fsrsState?: number;
}

/** The fields a review writes over the stored schedule. */
export interface ScheduledSrs {
  nextReview: number;
  /** Minutes until the next review. */
  interval: number;
  memoryStrength: number;
  lastReviewDate: number;
  totalReviews: number;
  correctStreak: number;
  stability: number;
  scheduler: 'fsrs-v6';
  difficulty: number;
  lapses: number;
  fsrsState: number;
  learningSteps: number;
  scheduledDays: number;
}

const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 3650,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ['10m'],
  relearning_steps: ['10m'],
});
const ratingMap: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

/** The 0–100 strength a mastery badge shows, as the client's SRSAlgorithm.stabilityToDisplayStrength computes it. */
function stabilityToDisplayStrength(stability: number): number {
  if (stability <= 0) return 0;
  return Math.min(100, Math.round(18 * Math.log(1 + stability)));
}

function toFsrsCard(srs: SrsLike, now: number): CardInput {
  if ((Number(srs.totalReviews) || 0) === 0) return createEmptyCard(new Date(srs.nextReview || now));
  const lastReview = Number(srs.lastReviewDate) || Math.max(0, now - Math.max(1, Number(srs.interval) || 0) * 60_000);
  return {
    due: new Date(srs.nextReview || now),
    stability: Math.max(0.1, Number(srs.stability) || 0.5),
    difficulty: Math.min(10, Math.max(1, Number(srs.difficulty) || 5)),
    // CardInput still requires the deprecated elapsed_days, but the scheduler recomputes it from last_review.
    elapsed_days: 0,
    scheduled_days: Math.max(0, srs.scheduledDays ?? Math.round((Number(srs.interval) || 0) / 1440)),
    learning_steps: Math.max(0, Number(srs.learningSteps) || 0),
    reps: Math.max(1, Number(srs.totalReviews) || 0),
    lapses: Math.max(0, Number(srs.lapses) || 0),
    state: srs.fsrsState ?? State.Review,
    last_review: new Date(lastReview),
  };
}

function fromFsrsCard<T extends SrsLike>(previous: T, card: Card, rating: ReviewRating, reviewedAt: number): T & ScheduledSrs {
  const interval = Math.max(1, Math.round((card.due.getTime() - reviewedAt) / 60_000));
  return {
    ...previous,
    nextReview: card.due.getTime(),
    interval,
    memoryStrength: stabilityToDisplayStrength(card.stability),
    lastReviewDate: reviewedAt,
    totalReviews: card.reps,
    correctStreak: rating === 'again' ? 0 : (Number(previous.correctStreak) || 0) + 1,
    stability: card.stability,
    scheduler: 'fsrs-v6',
    difficulty: card.difficulty,
    lapses: card.lapses,
    fsrsState: card.state,
    learningSteps: card.learning_steps,
    scheduledDays: card.scheduled_days,
  };
}

/**
 * Server-authoritative FSRS v6 transition with the review's practice membership (shared/practice.ts) applied;
 * defaults legacy clients to Good. Other fields of `srs` carry over. The schedule is stamped `reviewedAt`, or the
 * last review's time when that is later: a schedule's clock only moves forward, and ts-fsrs refuses a review dated a
 * day before the last one. `eventTime` is when the review was made (the client's own time, which db/reviews.ts also
 * clamps for the stamp), and decides whether the review predates the item's last change of membership.
 */
export function advanceReviewSrs<T extends SrsLike>(
  srs: T,
  reviewedAt: number,
  rating: ReviewRating = 'good',
  taskType?: ReviewTaskType,
  eventTime = reviewedAt,
): T & ScheduledSrs {
  const stampedAt = Math.max(reviewedAt, Number(srs.lastReviewDate) || 0);
  const result = scheduler.next(toFsrsCard(srs, stampedAt), new Date(stampedAt), ratingMap[rating]);
  return applyPracticeMembership(srs, fromFsrsCard(srs, result.card, rating, stampedAt), taskType, rating, eventTime, stampedAt);
}
