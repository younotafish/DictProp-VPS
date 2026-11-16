import { useCallback } from 'react';
import { log } from '../services/logger';
import { isActiveLibraryItem } from './useLibraryViews';
import type { JobNotices } from './useJobNotice';
import type { Library } from './useLibrary';
import type { Overlays } from './useOverlays';

export function useDuplicateMerge(
  { latestItemsRef, updateItems, persistChangedItems }: Pick<Library, 'latestItemsRef' | 'updateItems' | 'persistChangedItems'>,
  { setDuplicateClusters }: Pick<Overlays, 'setDuplicateClusters'>,
  { showJobNotice }: Pick<JobNotices, 'showJobNotice'>,
) {
  // ── Find & merge variant duplicates (Phase 2 dedup tool) ──────────────────
  // Detection is read-only: cluster base words that are variants of one another
  // (run/running/ran), then open the review modal. Scans the whole notebook.
  // Finding none is a passing pill (services/jobNotices); the merge itself stays a decision in the dialog.
  const handleFindDuplicates = useCallback(async () => {
    const { findDuplicateClusterViews, describeDuplicateScan } = await import('../services/libraryTools');
    const detailed = findDuplicateClusterViews(latestItemsRef.current.filter(isActiveLibraryItem));
    const notice = describeDuplicateScan(detailed.length);
    if (notice) showJobNotice(notice);
    else setDuplicateClusters(detailed);
  }, [latestItemsRef, setDuplicateClusters, showJobNotice]);

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
  }, [latestItemsRef, setDuplicateClusters, updateItems, persistChangedItems]);

  return { handleFindDuplicates, handleMergeDuplicates };
}
