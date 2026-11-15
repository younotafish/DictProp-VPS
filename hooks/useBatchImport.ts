import { useCallback, useState } from 'react';
import { analyzeInput } from '../services/api';
import type { BatchImportProgress } from '../services/batchImport';
import { warn } from '../services/logger';
import type { Library } from './useLibrary';
import type { LibraryActions } from './useLibraryActions';
import type { Overlays } from './useOverlays';
import type { SpeechBackfill } from './useSpeechBackfill';

export type { BatchImportProgress } from '../services/batchImport';

/** Batch import, which analyzes and saves a list of words in the background (services/batchImport). */
export function useBatchImport(
  { latestItemsRef, persistChangedItems }: Pick<Library, 'latestItemsRef' | 'persistChangedItems'>,
  { setConfirmModal, showNotice }: Pick<Overlays, 'setConfirmModal' | 'showNotice'>,
  { handleSave }: Pick<LibraryActions, 'handleSave'>,
  { runSpeechGenerationRef }: Pick<SpeechBackfill, 'runSpeechGenerationRef'>,
) {
  // The import under way, shown in the notebook; null while none runs.
  const [batchImportProgress, setBatchImportProgress] = useState<BatchImportProgress | null>(null);

  const handleBatchImport = useCallback(async (words: string[]) => {
    if (words.length === 0) return;

    const { runBatchImport } = await import('../services/libraryTools');
    const outcome = await runBatchImport(words, {
      items: () => latestItemsRef.current,
      analyze: word => analyzeInput(word, { mode: 'batch' }),
      save: handleSave,
      report: setBatchImportProgress,
    });

    if (outcome.kind === 'all-saved') {
      showNotice({
        title: 'All Already Saved',
        message: `All ${outcome.listed} words are already in your notebook.`,
        variant: 'info',
      });
      return;
    }
    const { saved, skipped, failed, failedWords, importedIds } = outcome;

    setBatchImportProgress(null);

    setConfirmModal({
      title: 'Batch Import Complete',
      message: `${saved} vocab cards saved${skipped > 0 ? `\n${skipped} skipped (already saved)` : ''}${failed > 0 ? `\n${failed} failed` : ''}`,
      confirmText: failedWords.length > 0 ? 'Retry Failed' : 'OK',
      variant: failed > 0 ? 'warning' : 'success',
      onConfirm: () => {
        setConfirmModal(null);
        if (failedWords.length > 0) {
          handleBatchImport(failedWords);
        }
      },
      showCancel: failedWords.length > 0,
      cancelText: 'Dismiss',
    });

    // Persist the new basic cards immediately so the Mac-local enrichment cycle can discover them.
    // Audio remains safe to pre-generate here; advanced text and images do not use VPS inference.
    if (importedIds.length > 0) {
      void (async () => {
        const imported = new Set(importedIds);
        await persistChangedItems(latestItemsRef.current.filter(item => imported.has(item.data.id)), 'Batch import');
      })().catch(e => warn('Post-batch persistence failed:', e));
      runSpeechGenerationRef.current(importedIds, { silent: true }).catch(e => warn('Post-batch speech generation failed:', e));
    }
  }, []);

  return { batchImportProgress, handleBatchImport };
}
