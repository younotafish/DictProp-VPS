import { isVocabItem, type StoredItem } from '../types';
import { cardBase, findDuplicateClusters } from './wordMatch';

/**
 * One cluster of variant-duplicate words (base words ["run", "running"]): the saved cards involved, in library
 * order, how many of them each base word has, and the headword to suggest keeping.
 */
export interface DuplicateClusterView {
  id: string;
  baseWords: string[];
  items: StoredItem[];
  /** Cards per base word, counted by the normalized base the cluster is made of, so "don’t" counts under "don't". */
  counts: Record<string, number>;
  suggestedCanonical: string;
}

/**
 * The variant-duplicate clusters (run/running/ran) among the active items, to review before merging: those
 * holding at least two cards, each suggesting its shortest base word (the alphabetically first among equals)
 * as the spelling to keep. One pass over the items fills every cluster. Finding them changes nothing.
 */
export function findDuplicateClusterViews(activeItems: StoredItem[]): DuplicateClusterView[] {
  // findDuplicateClusters lists each cluster's base words shortest first, the alphabetically first among equals.
  const clusters: DuplicateClusterView[] = findDuplicateClusters(activeItems).map((baseWords, i) => ({
    id: `dup-${i}`,
    baseWords,
    items: [],
    counts: Object.fromEntries(baseWords.map(base => [base, 0])),
    suggestedCanonical: baseWords[0],
  }));
  const clusterByBase = new Map<string, DuplicateClusterView>();
  for (const cluster of clusters) for (const base of cluster.baseWords) clusterByBase.set(base, cluster);

  for (const item of activeItems) {
    if (!isVocabItem(item)) continue;
    const base = cardBase(item.data);
    const cluster = clusterByBase.get(base);
    if (!cluster) continue;
    cluster.items.push(item);
    cluster.counts[base] += 1;
  }
  return clusters.filter(c => c.items.length >= 2);
}
