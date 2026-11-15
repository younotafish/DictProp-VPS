import { useCallback } from 'react';
import { log } from '../services/logger';
import { isActiveLibraryItem } from './useLibraryViews';
import type { Library } from './useLibrary';
import type { Overlays } from './useOverlays';

export function useDuplicateMerge(
  { latestItemsRef, updateItems, persistChangedItems }: Pick<Library, 'latestItemsRef' | 'updateItems' | 'persistChangedItems'>,
  { showNotice, setDuplicateClusters }: Pick<Overlays, 'showNotice' | 'setDuplicateClusters'>,
) {
  // ── Find & merge variant duplicates (Phase 2 dedup tool) ──────────────────
  // Detection is read-only: cluster base words that are variants of one another
  // (run/running/ran), then open the review modal. Scans the whole notebook.
  const handleFindDuplicates = useCallback(async () => {
    const { findDuplicateClusterViews } = await import('../services/libraryTools');
    const detailed = findDuplicateClusterViews(latestItemsRef.current.filter(isActiveLibraryItem));

    if (detailed.length === 0) {
      showNotice({
        title: 'No Duplicates Found',
        message: 'No variant duplicates detected — your words are already consolidated. 🎉',
        variant: 'success',
      });
      return;
    }
    setDuplicateClusters(detailed);
  }, []);

  // Apply the user-confirmed merges: relabel to canonical, union forms, dedupe senses,
  // and push the changed items immediately (like delete/SRS paths).
  const handleMergeDuplicates = useCallback(async (merges: Array<{ baseWords: string[]; canonical: string }>) => {
    setDuplicateClusters(null);
    if (!merges || merges.length === 0) return;
    const { applyMerges } = await import('../services/libraryTools');

    // applyMerges replaces items in place in a copy, so an index-wise identity check finds the changes.
    const before = latestItemsRef.current;
    const after = updateItems(items => applyMerges(items, merges));
    const changed = after.filter((item, index) => item !== before[index]);
    log(`🔀 Merge: ${changed.length} item(s) changed across ${merges.length} cluster(s)`);
    await persistChangedItems(changed, '🔀 Merge');
  }, [updateItems, persistChangedItems]);

  return { handleFindDuplicates, handleMergeDuplicates };
}
