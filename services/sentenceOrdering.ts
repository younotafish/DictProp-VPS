import type { StoredItem } from '../types';

export type SentenceReviewFilter = 'all' | 'unreviewed' | 'due' | 'memorized';

export const compareSentencesByLearningPriority = (a: StoredItem, b: StoredItem): number => {
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
    .filter(item => {
      if (filter === 'all') return true;
      const reviews = item.srs?.totalReviews ?? 0;
      if (filter === 'unreviewed') return reviews === 0;
      if (filter === 'due') return reviews > 0 && (item.srs?.nextReview ?? 0) <= now;
      return reviews > 0 && (item.srs?.nextReview ?? 0) > now;
    })
    .sort(compareSentencesByLearningPriority);
}
