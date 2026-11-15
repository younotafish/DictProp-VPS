import type { StoredItem, VocabCard } from '../../types';
import { cardBase, normalizeKey } from '../wordMatch';
import { getUsagePriority, sortVocabCardsByUsage } from '../usageAudit';

/**
 * The lookups that tell what's saved, as pure functions over the library's words and phrases. useLibraryViews
 * keeps them memoized; each one is fed the base words wordMatch's variant index maps a query to.
 */

/**
 * Base word → its most useful saved vocab item: the best usage status, then the most reviews, the first saved
 * winning a full tie. The review counts are those of the snapshot it's built from, close enough for a tie-break.
 */
export const buildSavedVocabByBase = (items: StoredItem[]): Map<string, StoredItem> => {
  const m = new Map<string, StoredItem>();
  for (const i of items) {
    if (i.type !== 'vocab') continue;
    const base = cardBase(i.data as VocabCard);
    if (!base) continue;
    const prev = m.get(base);
    const candidatePriority = getUsagePriority((i.data as VocabCard).usageAudit?.status);
    const previousPriority = prev
      ? getUsagePriority((prev.data as VocabCard).usageAudit?.status)
      : Number.POSITIVE_INFINITY;
    if (!prev || candidatePriority < previousPriority ||
        (candidatePriority === previousPriority && (i.srs?.totalReviews ?? 0) > (prev.srs?.totalReviews ?? 0))) {
      m.set(base, i);
    }
  }
  return m;
};

/** Of the items `bases` map to in the index above, the most reviewed one, the first base winning a tie; null if none. */
export const pickSavedItem = (bases: Iterable<string>, byBase: Map<string, StoredItem>): StoredItem | null => {
  let best: StoredItem | null = null;
  for (const b of bases) {
    const it = byBase.get(b);
    if (it && (!best || (it.srs?.totalReviews ?? 0) > (best.srs?.totalReviews ?? 0))) best = it;
  }
  return best;
};

/** Every saved card whose base word is one of `bases`, the most useful senses first. */
export const savedCardsForBases = (bases: Set<string>, items: StoredItem[]): VocabCard[] =>
  sortVocabCardsByUsage(items
    .filter(i => i.type === 'vocab' && bases.has(normalizeKey((i.data as VocabCard).word || '')))
    .map(i => i.data as VocabCard));
