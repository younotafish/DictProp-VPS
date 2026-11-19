import type { SRSData } from '../types';
import { sentenceReviewState, type SentenceReviewFilter } from './sentenceOrdering';

// The rule itself, a sentence's review state, the filter chips over it, whether it is to review and whether Today owns
// it, is written once, in sentenceOrdering.ts; this module passes it on beside what is built from it: the summaries,
// and what the chips say.
export {
  matchesReviewFilter, needsReview, ownedByToday, sentenceReviewState, type SentenceReviewState,
} from './sentenceOrdering';

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

/**
 * Counts each review state over the sentences' schedules (undefined for a sentence with no record yet). A sentence
 * Today owns counts as memorized, never to review (sentenceReviewState).
 */
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

/**
 * What the review chips say on the Sentences tab and in a Real Life collection, and so what an empty list under one
 * has none of. A sentence never reviewed is New, as on the reading tiles, the Study dashboard and a card's memory badge.
 */
export const REVIEW_FILTER_LABELS: Readonly<Record<SentenceReviewFilter, string>> = {
  all: 'All',
  unreviewed: 'New',
  due: 'Due',
  memorized: 'Memorized',
};
