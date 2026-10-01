import { useCallback } from 'react';
import type { VocabCard } from '../types';
import type { DuplicateClusterView } from '../components/DuplicatesModal';
import { applyMerges } from '../services/mergeDuplicates';
import { findDuplicateClusters, normalizeKey } from '../services/wordMatch';
import { log } from '../services/logger';
import { isActiveLibraryItem } from './useLibraryViews';
import type { Library } from './useLibrary';
import type { Overlays } from './useOverlays';

export function useDuplicateMerge(
  { latestItemsRef, updateItems, persistChangedItems }: Pick<Library, 'latestItemsRef' | 'updateItems' | 'persistChangedItems'>,
  { setConfirmModal, setDuplicateClusters }: Pick<Overlays, 'setConfirmModal' | 'setDuplicateClusters'>,
) {
  // ── Find & merge variant duplicates (Phase 2 dedup tool) ──────────────────
  // Detection is read-only: cluster base words that are variants of one another
  // (run/running/ran), then open the review modal. Scans the whole notebook.
  const handleFindDuplicates = useCallback(() => {
    const activeItems = latestItemsRef.current.filter(isActiveLibraryItem);
    const clusters = findDuplicateClusters(activeItems);
    const detailed: DuplicateClusterView[] = clusters
      .map((baseWords, i) => {
        const set = new Set(baseWords);
        const clusterItems = activeItems.filter(
          it => it.type === 'vocab' && set.has(normalizeKey((it.data as VocabCard).word || ''))
        );
        const suggestedCanonical = [...baseWords].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
        return { id: `dup-${i}`, baseWords, items: clusterItems, suggestedCanonical };
      })
      .filter(c => c.items.length >= 2);

    if (detailed.length === 0) {
      setConfirmModal({
        isOpen: true,
        title: 'No Duplicates Found',
        message: 'No variant duplicates detected — your words are already consolidated. 🎉',
        confirmText: 'OK',
        variant: 'success',
        onConfirm: () => setConfirmModal(null),
        showCancel: false,
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

    // applyMerges replaces items in place in a copy, so an index-wise identity check finds the changes.
    const before = latestItemsRef.current;
    const after = updateItems(items => applyMerges(items, merges));
    const changed = after.filter((item, index) => item !== before[index]);
    log(`🔀 Merge: ${changed.length} item(s) changed across ${merges.length} cluster(s)`);
    await persistChangedItems(changed, '🔀 Merge');
  }, [updateItems, persistChangedItems]);

  return { handleFindDuplicates, handleMergeDuplicates };
}
