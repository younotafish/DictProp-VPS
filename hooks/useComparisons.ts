import { useCallback, useEffect, useRef, useState } from 'react';
import { comparisonKey, type ComparisonResult, type StoredComparison } from '../types';
import type { AuthState } from '../services/auth';
import { loadComparisons, saveComparisonApi } from '../services/api';
import { warn } from '../services/logger';

// ── Word comparisons (persisted server + local, keyed by the word-set) ──────
// The GENERATION queue lives in GlobalSearch (the bottom-right search queue) so comparisons behave
// exactly like word searches. This hook just owns the persisted store + the save/lookup callbacks.
export function useComparisons(authState: AuthState) {
  const [comparisons, setComparisons] = useState<StoredComparison[]>([]);
  const comparisonsRef = useRef<StoredComparison[]>([]);
  useEffect(() => { comparisonsRef.current = comparisons; }, [comparisons]);

  const comparisonsCacheKey = authState.user ? `vps_comparisons_cache_${authState.user.id}` : 'vps_comparisons_cache';

  const persistComparisons = useCallback((list: StoredComparison[]) => {
    setComparisons(list);
    try { localStorage.setItem(comparisonsCacheKey, JSON.stringify(list)); } catch { /* ignore */ }
  }, [comparisonsCacheKey]);

  // Restore from localStorage instantly, then refresh from the server, once auth resolves.
  useEffect(() => {
    if (authState.loading || !authState.user) return;
    try {
      const cached = localStorage.getItem(comparisonsCacheKey);
      if (cached) { const c = JSON.parse(cached); if (Array.isArray(c)) setComparisons(c); }
    } catch { /* ignore */ }
    loadComparisons().then(persistComparisons).catch((e) => warn('Failed to load comparisons:', e));
  }, [authState.loading, authState.user?.id, comparisonsCacheKey, persistComparisons]);

  // A finished comparison from the search queue → save it (state + local cache + server).
  const handleCompareReady = useCallback((words: string[], data: ComparisonResult) => {
    const c: StoredComparison = { key: comparisonKey(words), words, data, updatedAt: Date.now() };
    persistComparisons([...comparisonsRef.current.filter((x) => x.key !== c.key), c]);
    saveComparisonApi(c).catch((e) => warn('Failed to save comparison to server:', e));
  }, [persistComparisons]);

  // Word comparison handler (used by EVERY Compare button — synonyms + confusables). Non-blocking:
  // if we already have this comparison, open it instantly; otherwise enqueue it for background
  // generation (the bottom-right search button shows it in progress) and let the user keep working.
  // Trigger a comparison through the SAME bottom-right queue as word search (background, non-blocking).
  // If it's already saved, pass the cached result so the popup opens instantly; else it generates.
  const handleCompare = useCallback((words: string[]) => {
    if (words.length < 2) return; // the pickers stop at MAX_COMPARE_WORDS, and compareWords enforces it
    const key = comparisonKey(words);
    if (!key) return;
    const existing = comparisonsRef.current.find((c) => c.key === key);
    window.dispatchEvent(new CustomEvent('global-compare', { detail: { words, result: existing?.data ?? null } }));
  }, []);
  // Opening a saved comparison (from a word page) routes to the same place — the search popup.
  const handleOpenComparison = handleCompare;

  return { comparisons, handleCompareReady, handleCompare, handleOpenComparison };
}
