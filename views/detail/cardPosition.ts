import type { ItemGroup } from '../../types';
import { needsReview } from '../../services/sentenceReviewState';

/**
 * For each word of the card view and the end past it, how many words from there on have a card to review: one never
 * reviewed or due now (needsReview) and not archived, the rule the Notebook's Due badges and its 'to review' count
 * follow. The view counts once per list and reads the words after the one on screen at index + 1.
 */
export function buildToReviewFrom(groups: readonly ItemGroup[], now: number): number[] {
  const counts = new Array<number>(groups.length + 1).fill(0);
  for (let index = groups.length - 1; index >= 0; index--) {
    const toReview = groups[index].items.some(item => !item.isArchived && needsReview(item.srs, now));
    counts[index] = counts[index + 1] + (toReview ? 1 : 0);
  }
  return counts;
}

/**
 * The line at the end of a card: where it is in the view ('Word 12 of 230'), then how many words after it are left to
 * review, when any are, or 'archived' for an archived card. Nothing for a view of one word.
 */
export function cardPositionLine({ index, total, toReviewAfter, archived }: {
  index: number;
  total: number;
  toReviewAfter: number;
  archived: boolean;
}): string | null {
  if (total <= 1) return null;
  const position = `Word ${index + 1} of ${total}`;
  if (archived) return `${position} · archived`;
  return toReviewAfter > 0 ? `${position} · ${toReviewAfter} to review after this` : position;
}
