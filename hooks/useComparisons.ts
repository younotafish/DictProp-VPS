import { useCallback, useEffect, useRef, useState } from 'react';
import { comparisonKey, type ComparisonResult, type StoredComparison } from '../types';
import { loadComparisons, saveComparisonApi } from '../services/api/comparisons';
import { warn } from '../services/logger';
import { mergeComparisons, readCachedComparisons, writeCachedComparisons } from '../components/search/storedComparisons';

// ── Word comparisons (persisted server + local, keyed by the word-set) ──────
// The GENERATION queue is the search queue (components/search/useSearchQueue, which GlobalSearch hosts), so
// comparisons behave exactly like word searches. This hook just owns the persisted store + the save/lookup callbacks.
// Comparisons belong to the signed-in account `userId`; the search that produces them only runs signed in.
export function useComparisons(userId: string) {
  const [comparisons, setComparisons] = useState<StoredComparison[]>([]);
  // The current list, set together with the state (as useLibrary's latestItemsRef is), so a change made before
  // React renders the previous one still builds on it.
  const comparisonsRef = useRef<StoredComparison[]>([]);

  const persistComparisons = useCallback((list: StoredComparison[]) => {
    comparisonsRef.current = list;
    setComparisons(list);
    writeCachedComparisons(userId, list);
  }, [userId]);

  // Restore from localStorage instantly, then merge in the server's list. The merge keeps the comparisons the
  // server doesn't have yet, and the newer copy of each, and sends the server the ones it doesn't have: a save that
  // failed (offline, a deploy, an expired session) is tried again at each load until it lands.
  useEffect(() => {
    const cached = readCachedComparisons(userId);
    if (cached) {
      comparisonsRef.current = cached;
      setComparisons(cached);
    }
    let cancelled = false;
    loadComparisons().then((server) => {
      if (cancelled) return;
      const { merged, toUpload } = mergeComparisons(comparisonsRef.current, server);
      persistComparisons(merged);
      for (const c of toUpload) saveComparisonApi(c).catch((e) => warn('Failed to save comparison to server:', e));
    }).catch((e) => warn('Failed to load comparisons:', e));
    return () => { cancelled = true; };
  }, [userId, persistComparisons]);

  // A finished comparison from the search queue → save it (state + local cache + server).
  const handleCompareReady = useCallback((words: string[], data: ComparisonResult) => {
    const c: StoredComparison = { key: comparisonKey(words), words, data, updatedAt: Date.now() };
    persistComparisons([...comparisonsRef.current.filter((x) => x.key !== c.key), c]);
    saveComparisonApi(c).catch((e) => warn('Failed to save comparison to server:', e));
  }, [persistComparisons]);

  // Every Compare button (synonyms, confusables, a saved comparison on a word's page) goes through the search
  // queue, in the background: a comparison already saved opens at once in the search popup, and a new one is
  // generated while the user keeps working, with the search button showing its progress.
  const handleCompare = useCallback((words: string[]) => {
    if (words.length < 2) return; // the pickers stop at MAX_COMPARE_WORDS, and compareWords enforces it
    const key = comparisonKey(words);
    if (!key) return;
    const existing = comparisonsRef.current.find((c) => c.key === key);
    window.dispatchEvent(new CustomEvent('global-compare', { detail: { words, result: existing?.data ?? null } }));
  }, []);

  return { comparisons, handleCompareReady, handleCompare };
}
