import type { StoredItem, VocabCard } from '../types';
import type { DuplicateClusterView } from '../components/DuplicatesModal';
import { findDuplicateClusters, normalizeKey } from './wordMatch';

/**
 * The variant-duplicate clusters (run/running/ran) among the active items, to review before merging: those
 * holding at least two cards, each suggesting its shortest base word (the alphabetically first among equals)
 * as the spelling to keep. Finding them changes nothing.
 */
export function findDuplicateClusterViews(activeItems: StoredItem[]): DuplicateClusterView[] {
  return findDuplicateClusters(activeItems)
    .map((baseWords, i) => {
      const set = new Set(baseWords);
      const clusterItems = activeItems.filter(
        it => it.type === 'vocab' && set.has(normalizeKey((it.data as VocabCard).word || ''))
      );
      const suggestedCanonical = [...baseWords].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
      return { id: `dup-${i}`, baseWords, items: clusterItems, suggestedCanonical };
    })
    .filter(c => c.items.length >= 2);
}
