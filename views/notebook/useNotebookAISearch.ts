import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchResult } from '../../types';
import { analyzeInput } from '../../services/api/ai';
import { speakWord, ensureTTS } from '../../services/neuralTts';
import { error as logError } from '../../services/logger';

/**
 * The notebook's inline AI lookup: the result card above the list, its error and its spinner. A newer lookup
 * supersedes an older one, and clearAISearch drops whatever is showing or still on its way.
 */
export function useNotebookAISearch(isOnline: boolean) {
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Each lookup and each clear takes the next generation, so a lookup that lands after either is discarded.
  const searchGenerationIdRef = useRef(0);
  // Whether the notebook tab is showing. A hidden tab's <Activity> runs this effect's cleanup and runs it again
  // when the tab shows, so a lookup that lands while another tab shows doesn't speak over it.
  const shownRef = useRef(false);
  useEffect(() => {
    shownRef.current = true;
    return () => { shownRef.current = false; };
  }, []);

  // AI Search function
  const performAISearch = useCallback(async (query: string) => {
    if (!query.trim() || !isOnline) return;

    setIsSearching(true);
    setSearchError(null);
    setSearchResults(null);

    // A newer search or a clear moves the generation on; this search's result, error and spinner then go unused.
    const currentGenId = ++searchGenerationIdRef.current;
    const isCurrent = () => searchGenerationIdRef.current === currentGenId;

    try {
      const result = await analyzeInput(query.trim());
      if (!isCurrent()) return; // Superseded by a new search, or cleared
      setSearchResults(result);

      // Prepare the API audio for the example sentences up front (generate if needed) so the first
      // tap plays instantly from the cache instead of hitting a cache-miss fallback.
      ensureTTS((result.vocabs || []).flatMap(v => v.examples || []));

      // Auto-pronounce the word once when results arrive
      if (result.vocabs && result.vocabs.length > 0) {
        const wordToSpeak = result.vocabs[0].word || query.trim();
        setTimeout(() => {
          if (isCurrent() && shownRef.current) speakWord(wordToSpeak);
        }, 100);

        // The immediate result is intentionally text-only. The Mac's local enrichment cycle creates
        // the advanced metadata and image after the item is saved.
      }
    } catch (err) {
      logError('AI Search failed:', err);
      if (isCurrent()) setSearchError((err as Error).message || 'Search failed. Please try again.');
    } finally {
      if (isCurrent()) setIsSearching(false);
    }
  }, [isOnline]);

  /** Drops the result card, the error and any lookup still on its way, and stops the spinner. */
  const clearAISearch = useCallback(() => {
    searchGenerationIdRef.current++;
    setSearchResults(null);
    setSearchError(null);
    setIsSearching(false);
  }, []);

  return { isSearching, searchResults, searchError, setSearchError, performAISearch, clearAISearch };
}
