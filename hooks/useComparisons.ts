import { useCallback, useEffect, useRef, useState } from 'react';
import { comparisonKey, type ComparisonResult, type StoredComparison } from '../types';
import type { AuthState } from '../services/auth';
import { loadComparisons, saveComparisonApi } from '../services/api';
import { warn } from '../services/logger';
import { readCachedComparisons, writeCachedComparisons } from '../components/search/storedComparisons';

// ── Word comparisons (persisted server + local, keyed by the word-set) ──────
// The GENERATION queue lives in GlobalSearch (the bottom-right search queue) so comparisons behave
// exactly like word searches. This hook just owns the persisted store + the save/lookup callbacks.
export function useComparisons(authState: AuthState) {
  const [comparisons, setComparisons] = useState<StoredComparison[]>([]);
  const comparisonsRef = useRef<StoredComparison[]>([]);
  useEffect(() => { comparisonsRef.current = comparisons; }, [comparisons]);
  // Comparisons belong to the signed-in user; the search that produces them only runs signed in.
  const userId = authState.user?.id;

  const persistComparisons = useCallback((list: StoredComparison[]) => {
    setComparisons(list);
    if (userId) writeCachedComparisons(userId, list);
  }, [userId]);

  // Restore from localStorage instantly, then refresh from the server, once auth resolves.
  useEffect(() => {
    if (authState.loading || !userId) return;
    const cached = readCachedComparisons(userId);
    if (cached) setComparisons(cached);
    loadComparisons().then(persistComparisons).catch((e) => warn('Failed to load comparisons:', e));
  }, [authState.loading, userId, persistComparisons]);

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

  // Opening a saved comparison from a word page is the same request.
  return { comparisons, handleCompareReady, handleCompare, handleOpenComparison: handleCompare };
}
