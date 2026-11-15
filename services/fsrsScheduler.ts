/**
 * FSRS v6 scheduling of explicit reviews, apart from the progress records in srsAlgorithm.ts so that the
 * scheduler loads only where reviews happen. The device shows a review's new schedule at once; the server then
 * applies the same review and its result is the one every device keeps.
 *
 * - Again / Hard / Good / Easy are deterministic (fuzz disabled)
 * - Existing fixed-schedule rows become FSRS rows on their next review
 * - The legacy "remember" action maps to Good
 *
 * MIRRORED in server/src/srs.ts: the server compiles only its own src/, and this copy has to stay out of the
 * first bundle, so each side holds one, and both need ts-fsrs, so neither can live in server/src/shared/. KEEP
 * THE SCHEDULER CONFIG, toFsrsCard AND fromFsrsCard IDENTICAL: test/contracts/srs.test.ts runs the same reviews
 * through both copies and compares every schedule field, or each review would visibly jump after the next sync.
 */

import { Rating, State, createEmptyCard, fsrs, type Card, type CardInput, type Grade } from 'ts-fsrs';
import { SRSData, type ReviewRating } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';

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

function toFsrsCard(srs: SRSData, now: number): CardInput {
  if ((srs.totalReviews || 0) === 0) return createEmptyCard(new Date(srs.nextReview || now));
  const lastReview = srs.lastReviewDate || Math.max(0, now - Math.max(1, srs.interval) * 60_000);
  return {
    due: new Date(srs.nextReview || now),
    stability: Math.max(0.1, Number(srs.stability) || 0.5),
    difficulty: Math.min(10, Math.max(1, Number(srs.difficulty) || 5)),
    // CardInput still requires the deprecated elapsed_days, but the scheduler recomputes it from last_review.
    elapsed_days: 0,
    scheduled_days: Math.max(0, srs.scheduledDays ?? Math.round((srs.interval || 0) / 1440)),
    learning_steps: Math.max(0, srs.learningSteps || 0),
    reps: Math.max(1, srs.totalReviews || 0),
    lapses: Math.max(0, srs.lapses || 0),
    state: srs.fsrsState ?? State.Review,
    last_review: new Date(lastReview),
  };
}

function fromFsrsCard(previous: SRSData, card: Card, rating: ReviewRating, reviewedAt: number): SRSData {
  const interval = Math.max(1, Math.round((card.due.getTime() - reviewedAt) / 60_000));
  return {
    ...previous,
    nextReview: card.due.getTime(),
    interval,
    memoryStrength: SRSAlgorithm.stabilityToDisplayStrength(card.stability),
    lastReviewDate: reviewedAt,
    totalReviews: card.reps,
    correctStreak: rating === 'again' ? 0 : (previous.correctStreak || 0) + 1,
    stability: card.stability,
    scheduler: 'fsrs-v6',
    difficulty: card.difficulty,
    lapses: card.lapses,
    fsrsState: card.state,
    learningSteps: card.learning_steps,
    scheduledDays: card.scheduled_days,
  };
}

export function updateAfterRating(srs: SRSData, rating: ReviewRating, now = Date.now()): SRSData {
  const card = toFsrsCard(srs, now);
  const result = scheduler.next(card, new Date(now), ratingMap[rating]);
  return fromFsrsCard(srs, result.card, rating, now);
}

export function previewRatings(srs: SRSData, now = Date.now()): Record<ReviewRating, SRSData> {
  return {
    again: updateAfterRating(srs, 'again', now),
    hard: updateAfterRating(srs, 'hard', now),
    good: updateAfterRating(srs, 'good', now),
    easy: updateAfterRating(srs, 'easy', now),
  };
}
