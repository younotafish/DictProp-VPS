import { Rating, State, createEmptyCard, fsrs, type Card, type CardInput, type Grade } from 'ts-fsrs';

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

const DAY_MS = 86_400_000;
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

function toFsrsCard(srs: any, now: number): CardInput {
  if ((Number(srs.totalReviews) || 0) === 0) {
    const empty = createEmptyCard(new Date(srs.nextReview || now));
    return { ...empty, due: new Date(srs.nextReview || now) };
  }
  const lastReview = Number(srs.lastReviewDate) || Math.max(0, now - Math.max(1, Number(srs.interval) || 0) * 60_000);
  return {
    due: new Date(srs.nextReview || now),
    stability: Math.max(0.1, Number(srs.stability) || 0.5),
    difficulty: Math.min(10, Math.max(1, Number(srs.difficulty) || 5)),
    elapsed_days: Math.max(0, Math.round((now - lastReview) / DAY_MS)),
    scheduled_days: Math.max(0, srs.scheduledDays ?? Math.round((Number(srs.interval) || 0) / 1440)),
    learning_steps: Math.max(0, Number(srs.learningSteps) || 0),
    reps: Math.max(1, Number(srs.totalReviews) || 0),
    lapses: Math.max(0, Number(srs.lapses) || 0),
    state: srs.fsrsState ?? State.Review,
    last_review: new Date(lastReview),
  };
}

function fromFsrsCard(previous: any, card: Card, rating: ReviewRating, reviewedAt: number): any {
  const interval = Math.max(1, Math.round((card.due.getTime() - reviewedAt) / 60_000));
  return {
    ...previous,
    nextReview: card.due.getTime(),
    interval,
    memoryStrength: card.stability <= 0 ? 0 : Math.min(100, Math.round(18 * Math.log(1 + card.stability))),
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

/** Server-authoritative FSRS v6 transition; defaults legacy clients to Good. */
export function advanceReviewSrs(srs: any, reviewedAt: number, rating: ReviewRating = 'good'): any {
  const result = scheduler.next(toFsrsCard(srs, reviewedAt), new Date(reviewedAt), ratingMap[rating]);
  return fromFsrsCard(srs, result.card, rating, reviewedAt);
}
