import { useCallback, useRef, useState } from 'react';
import type { BatchImportProgress } from '../services/batchImport';
import { warn } from '../services/logger';
import type { JobNotices } from './useJobNotice';
import type { Library } from './useLibrary';
import type { LibraryActions } from './useLibraryActions';
import type { SpeechBackfill } from './useSpeechBackfill';

/** A batch import under way, as its pill shows it: how far it has got, and whether Stop has been pressed. */
export interface BatchImportStatus extends BatchImportProgress { stopping: boolean }

/**
 * Batch import, which analyzes and saves a list of words in the background (services/batchImport): a pill on every tab
 * shows how far it has got and can stop it, and its result is a job notice (services/jobNotices).
 */
export function useBatchImport(
  { latestItemsRef, persistChangedItems }: Pick<Library, 'latestItemsRef' | 'persistChangedItems'>,
  { showJobNotice }: Pick<JobNotices, 'showJobNotice'>,
  { handleSave }: Pick<LibraryActions, 'handleSave'>,
  { runSpeechGeneration }: Pick<SpeechBackfill, 'runSpeechGeneration'>,
) {
  // The import under way, null while none runs, and the stop for its run.
  const [batchImportProgress, setBatchImportProgress] = useState<BatchImportStatus | null>(null);
  const runRef = useRef<AbortController | null>(null);

  const handleBatchImport = useCallback(async (words: string[]) => {
    // One import at a time: the tools menu's row is busy while one runs, and a result's Retry waits for it.
    if (words.length === 0 || runRef.current) return;
    const run = new AbortController();
    runRef.current = run;
    try {
      // The import's work, its texts and the AI client stay out of the first chunk; App fetches them once the first
      // screen is up.
      const [{ runBatchImport, describeBatchResult }, { analyzeInput }] = await Promise.all([
        import('../services/libraryTools'),
        import('../services/api/ai'),
      ]);
      const outcome = await runBatchImport(words, {
        items: () => latestItemsRef.current,
        analyze: word => analyzeInput(word, { mode: 'batch' }),
        save: handleSave,
        report: progress => setBatchImportProgress({ ...progress, stopping: run.signal.aborted }),
        signal: run.signal,
      });
      showJobNotice(describeBatchResult(outcome));

      // Persist the new basic cards immediately so the Mac-local enrichment cycle can discover them.
      // Audio remains safe to pre-generate here; advanced text and images do not use VPS inference.
      if (outcome.kind !== 'all-saved' && outcome.importedIds.length > 0) {
        const imported = new Set(outcome.importedIds);
        persistChangedItems(latestItemsRef.current.filter(item => imported.has(item.data.id)), 'Batch import')
          .catch(e => warn('Post-batch persistence failed:', e));
        runSpeechGeneration(outcome.importedIds, { silent: true }).catch(e => warn('Post-batch speech generation failed:', e));
      }
    } finally {
      runRef.current = null;
      setBatchImportProgress(null);
    }
  }, [latestItemsRef, persistChangedItems, handleSave, showJobNotice, runSpeechGeneration]);

  // The pill's Stop: no word starts after it, and the words under way finish (services/batchImport).
  const stopBatchImport = useCallback(() => {
    runRef.current?.abort();
    setBatchImportProgress(progress => progress && { ...progress, stopping: true });
  }, []);

  return { batchImportProgress, batchImportRunning: batchImportProgress !== null, handleBatchImport, stopBatchImport };
}
