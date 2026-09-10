import type { StoredItem } from '../types';

export type SentenceReviewFilter = 'all' | 'unreviewed' | 'due' | 'memorized';

export const compareSentencesByLearningPriority = (a: StoredItem, b: StoredItem): number => {
  const strengthDifference = (a.srs?.memoryStrength ?? 0) - (b.srs?.memoryStrength ?? 0);
  if (strengthDifference) return strengthDifference;

  // Passive listening is not evidence of memorization, but it is evidence that this sentence was just
  // seen. Keep its real strength unchanged and rotate it behind equally weak sentences until they have
  // also been heard. Oldest/never-heard comes first; newest saved item breaks otherwise-equal ties.
  const exposureDifference = (a.srs?.lastExposureDate ?? 0) - (b.srs?.lastExposureDate ?? 0);
  return exposureDifference || (b.savedAt || 0) - (a.savedAt || 0);
};

export function orderSentencesForReview(
  items: StoredItem[],
  filter: SentenceReviewFilter,
  now: number,
): StoredItem[] {
  return items
    .filter(item => {
      if (filter === 'all') return true;
      const reviews = item.srs?.totalReviews ?? 0;
      if (filter === 'unreviewed') return reviews === 0;
      if (filter === 'due') return reviews > 0 && (item.srs?.nextReview ?? 0) <= now;
      return reviews > 0 && (item.srs?.nextReview ?? 0) > now;
    })
    .sort(compareSentencesByLearningPriority);
}
