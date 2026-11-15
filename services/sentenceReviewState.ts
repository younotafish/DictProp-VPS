import type { SRSData } from '../types';
import type { SentenceReviewFilter } from './sentenceOrdering';

/** Where a sentence stands in review; every sentence is exactly one of these. */
export type SentenceReviewState = 'unreviewed' | 'due' | 'memorized';

/**
 * Never reviewed (totalReviews 0), reviewed and due again (nextReview has passed), or reviewed and resting
 * until nextReview. totalReviews is a validated non-negative count.
 */
export function sentenceReviewState(srs: SRSData | undefined, now: number): SentenceReviewState {
  if ((srs?.totalReviews ?? 0) === 0) return 'unreviewed';
  return (srs?.nextReview ?? 0) <= now ? 'due' : 'memorized';
}

/** Whether a sentence belongs under a review filter chip. */
export const matchesReviewFilter = (srs: SRSData | undefined, filter: SentenceReviewFilter, now: number): boolean =>
  filter === 'all' || sentenceReviewState(srs, now) === filter;

/** Whether a study run takes the sentence: it was never reviewed, or it is due again. */
export const needsReview = (srs: SRSData | undefined, now: number): boolean =>
  sentenceReviewState(srs, now) !== 'memorized';

/** How a list of sentences stands in review. */
export interface ReviewSummary {
  total: number;
  reviewed: number;
  unreviewed: number;
  due: number;
  memorized: number;
  /** Unreviewed plus due: what a study run takes. */
  toReview: number;
  /** Memory strength (0-100) averaged over every sentence, an unreviewed one counting as 0. */
  masteryScore: number;
}

/** Counts each review state over the sentences' schedules (undefined for a sentence with no record yet). */
export function summarizeReviewStates(schedules: readonly (SRSData | undefined)[], now: number): ReviewSummary {
  let reviewed = 0;
  let due = 0;
  let memorized = 0;
  let strength = 0;

  for (const srs of schedules) {
    const state = sentenceReviewState(srs, now);
    if (state === 'unreviewed') continue;
    reviewed += 1;
    strength += Math.max(0, Math.min(100, srs?.memoryStrength ?? 0));
    if (state === 'due') due += 1;
    else memorized += 1;
  }

  const total = schedules.length;
  const unreviewed = total - reviewed;
  return {
    total,
    reviewed,
    unreviewed,
    due,
    memorized,
    toReview: unreviewed + due,
    masteryScore: total === 0 ? 0 : Math.round(strength / total),
  };
}
