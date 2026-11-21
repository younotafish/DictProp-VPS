import type { SRSData, StoredItem } from '../types';

export type SentenceReviewFilter = 'all' | 'unreviewed' | 'due' | 'memorized';

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

/**
 * Whether a sentence is to review: it was never reviewed, or it is due again. A study run and Today's units take these,
 * and the Sentences tab counts them in its header and on its tab-bar badge. The badge is counted in the app's first
 * chunk (hooks/useLibraryViews), which takes this module but not the summaries in sentenceReviewState.ts.
 */
export const needsReview = (srs: SRSData | undefined, now: number): boolean =>
  sentenceReviewState(srs, now) !== 'memorized';

/** Whether a sentence belongs under a review filter chip. */
export const matchesReviewFilter = (srs: SRSData | undefined, filter: SentenceReviewFilter, now: number): boolean =>
  filter === 'all' || sentenceReviewState(srs, now) === filter;

const compareSentencesByLearningPriority = (a: StoredItem, b: StoredItem): number => {
  const strengthDifference = (a.srs?.memoryStrength ?? 0) - (b.srs?.memoryStrength ?? 0);
  if (strengthDifference) return strengthDifference;

  // Listening is not memorization, so it doesn't move a sentence: among equally strong sentences the
  // order stays fixed (newest saved first) until a remember changes its strength.
  return (b.savedAt || 0) - (a.savedAt || 0);
};

export function orderSentencesForReview(
  items: StoredItem[],
  filter: SentenceReviewFilter,
  now: number,
): StoredItem[] {
  return items
    .filter(item => matchesReviewFilter(item.srs, filter, now))
    .sort(compareSentencesByLearningPriority);
}
