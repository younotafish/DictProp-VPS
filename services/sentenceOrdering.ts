import type { SRSData, StoredItem } from '../types';

export type SentenceReviewFilter = 'all' | 'unreviewed' | 'due' | 'memorized';

/** Where a sentence stands in review; every sentence is exactly one of these. */
export type SentenceReviewState = 'unreviewed' | 'due' | 'memorized';

/** How Today's loop holds a sentence it owns: it practises it, or it is done with it as one the learner can say. */
export type TodayStanding = 'practicing' | 'sayable';

/**
 * How Today's loop owns the sentence, or undefined where it doesn't: one of the learner's own that Today practises, or
 * that it is done with as one they can say, so nothing here asks to review it or names a date for it. Only a
 * sentence's schedule (srs.type 'sentence') counts: classic Study reads this module for words and phrases, and reviews
 * them even with membership left from when Today took words. Real Life and essay records never carry membership. The
 * fields are read here rather than through server/src/shared/practice.ts, which stays out of the app's first chunk;
 * practice comes first, as in its loopStanding.
 */
export function todayStanding(srs: SRSData | undefined): TodayStanding | undefined {
  if (srs?.type !== 'sentence') return undefined;
  if (srs.practiceSince !== undefined) return 'practicing';
  return srs.sayableAt !== undefined ? 'sayable' : undefined;
}

/** Whether Today's loop owns the sentence (todayStanding). */
export const ownedByToday = (srs: SRSData | undefined): boolean => todayStanding(srs) !== undefined;

/**
 * Never reviewed (totalReviews 0), reviewed and due again (nextReview has passed), or reviewed and resting
 * until nextReview. A sentence Today owns rests whatever its schedule says (ownedByToday). totalReviews is a validated
 * non-negative count.
 */
export function sentenceReviewState(srs: SRSData | undefined, now: number): SentenceReviewState {
  if (ownedByToday(srs)) return 'memorized';
  if ((srs?.totalReviews ?? 0) === 0) return 'unreviewed';
  return (srs?.nextReview ?? 0) <= now ? 'due' : 'memorized';
}

/**
 * Whether a sentence is to review: it was never reviewed, or it is due again, and Today doesn't own it. A study run
 * takes these, and the Sentences tab counts them in its header and on its tab-bar badge. The badge is counted in the
 * app's first chunk (hooks/useLibraryViews), which takes this module but not the summaries in sentenceReviewState.ts.
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
