import { useCallback, useRef, useState } from 'react';
import { isVocabItem, savedVocabKey, type StoredItem } from '../types';
import { analyzeInput } from '../services/api';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { log, warn } from '../services/logger';
import type { Library } from './useLibrary';
import type { LibraryActions } from './useLibraryActions';
import type { Overlays } from './useOverlays';
import type { SpeechBackfill } from './useSpeechBackfill';

export function useBatchImport(
  { latestItemsRef, persistChangedItems }: Pick<Library, 'latestItemsRef' | 'persistChangedItems'>,
  { setConfirmModal }: Pick<Overlays, 'setConfirmModal'>,
  { handleSaveRef }: Pick<LibraryActions, 'handleSaveRef'>,
  { runSpeechGenerationRef }: Pick<SpeechBackfill, 'runSpeechGenerationRef'>,
) {
  // Batch import state
  const [batchImportProgress, setBatchImportProgress] = useState<{
    current: number; total: number; skipped: number; failed: number; saved: number; isRunning: boolean;
  } | null>(null);
  const batchImportAbortRef = useRef(false);

  // ── Batch Import (background processing) ──────────────────────────────────

  const BATCH_CONCURRENCY = 5;

  const handleBatchImport = useCallback(async (words: string[]) => {
    if (words.length === 0) return;

    // The saved words and senses, looked up once rather than scanned per word, and kept current as this import
    // saves more, so a sense that two listed words both produce is saved once.
    const savedWords = new Set<string>();
    const savedSenses = new Set<string>();
    for (const item of latestItemsRef.current) {
      if (item.isDeleted || !isVocabItem(item)) continue;
      savedWords.add((item.data.word || '').toLowerCase().trim());
      savedSenses.add(savedVocabKey(item.data));
    }
    const listed = new Set<string>();
    const newWords: string[] = [];
    let skipped = 0;
    for (const word of words) {
      const w = word.toLowerCase().trim();
      if (listed.has(w)) continue;
      listed.add(w);
      if (savedWords.has(w)) skipped++;
      else newWords.push(word);
    }

    if (newWords.length === 0) {
      setConfirmModal({
        isOpen: true,
        title: 'All Already Saved',
        message: `All ${listed.size} words are already in your notebook.`,
        confirmText: 'OK',
        variant: 'info',
        onConfirm: () => setConfirmModal(null),
        showCancel: false,
      });
      return;
    }

    setBatchImportProgress({ current: 0, total: newWords.length, skipped, failed: 0, saved: 0, isRunning: true });
    batchImportAbortRef.current = false;

    let completed = 0;
    let failed = 0;
    let saved = 0;
    let index = 0;
    const failedWords: string[] = [];
    const importedItemIds: string[] = [];

    const processWord = async () => {
      while (index < newWords.length && !batchImportAbortRef.current) {
        const currentIndex = index++;
        const word = newWords[currentIndex];

        // Retry once on failure (with backoff for rate limiting)
        let lastError: any = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (attempt > 0) {
              log(`Batch import: retrying "${word}" (attempt ${attempt + 1})`);
              await new Promise(r => setTimeout(r, 2000));
            }

            const result = await analyzeInput(word, { mode: 'batch' });

            for (const vocab of result.vocabs || []) {
              const senseKey = savedVocabKey(vocab);
              if (!savedSenses.has(senseKey)) {
                savedSenses.add(senseKey);
                const storedItem: StoredItem = {
                  data: vocab,
                  type: 'vocab',
                  savedAt: Date.now(),
                  srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
                };
                handleSaveRef.current(storedItem);
                saved++;
                importedItemIds.push(vocab.id);

                // Advanced metadata and images are added by the Mac-local enrichment cycle.
              }
            }
            lastError = null;
            break; // success — exit retry loop
          } catch (err: any) {
            lastError = err;
            const msg = err?.message || '';
            // Back off extra on rate limiting before retry
            if (msg.includes('429') || msg.includes('QUOTA')) {
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        }

        if (lastError) {
          warn(`Batch import failed for "${word}":`, lastError?.message || '');
          failed++;
          failedWords.push(word);
        }

        completed++;
        setBatchImportProgress({ current: completed, total: newWords.length, skipped, failed, saved, isRunning: true });

        // Brief delay between requests to reduce rate limiting
        await new Promise(r => setTimeout(r, 300));
      }
    };

    // Launch concurrent workers
    const workers = Array.from(
      { length: Math.min(BATCH_CONCURRENCY, newWords.length) },
      () => processWord()
    );
    await Promise.all(workers);

    setBatchImportProgress(null);

    setConfirmModal({
      isOpen: true,
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
    if (importedItemIds.length > 0) {
      void (async () => {
        const importedIds = new Set(importedItemIds);
        const imported = latestItemsRef.current.filter(item => importedIds.has(item.data.id));
        await persistChangedItems(imported, 'Batch import');
      })().catch(e => warn('Post-batch persistence failed:', e));
      runSpeechGenerationRef.current(importedItemIds, { silent: true }).catch(e => warn('Post-batch speech generation failed:', e));
    }
  }, []);

  return { batchImportProgress, handleBatchImport };
}
