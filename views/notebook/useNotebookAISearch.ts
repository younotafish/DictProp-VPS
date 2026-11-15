import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchResult } from '../../types';
import { analyzeInput } from '../../services/api';
import { speakWord, ensureTTS } from '../../services/lazyTts';
import { error as logError } from '../../services/logger';

/**
 * The notebook's inline AI lookup: the result card above the list, its error and its spinner. Emptying the
 * query drops the card and the error.
 */
export function useNotebookAISearch(isOnline: boolean, typedQuery: string) {
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchGenerationIdRef = useRef(0); // Incremented on each search to discard stale analysis results

  // AI Search function
  const performAISearch = useCallback(async (query: string) => {
    if (!query.trim() || !isOnline) return;

    setIsSearching(true);
    setSearchError(null);
    setSearchResults(null);

    // Increment generation ID so a superseded search's result is discarded when it lands
    const currentGenId = ++searchGenerationIdRef.current;

    try {
      const result = await analyzeInput(query.trim());
      if (searchGenerationIdRef.current !== currentGenId) return; // Superseded by new search
      setSearchResults(result);

      // Prepare the API audio for the example sentences up front (generate if needed) so the first
      // tap plays instantly from the cache instead of hitting a cache-miss fallback.
      ensureTTS((result.vocabs || []).flatMap(v => v.examples || []));

      // Auto-pronounce the word once when results arrive
      if (result.vocabs && result.vocabs.length > 0) {
        const wordToSpeak = result.vocabs[0].word || query.trim();
        setTimeout(() => speakWord(wordToSpeak), 100);

        // The immediate result is intentionally text-only. The Mac's local enrichment cycle creates
        // the advanced metadata and image after the item is saved.
      }
    } catch (err: any) {
      logError('AI Search failed:', err);
      setSearchError(err.message || 'Search failed. Please try again.');
    } finally {
      setIsSearching(false);
    }
  }, [isOnline]);

  /** Drops the result card and the error. */
  const clearSearchResults = useCallback(() => {
    setSearchResults(null);
    setSearchError(null);
  }, []);

  // Clear search results when query is cleared
  useEffect(() => {
    if (!typedQuery.trim()) {
      setSearchResults(null);
      setSearchError(null);
    }
  }, [typedQuery]);

  return { isSearching, searchResults, searchError, setSearchError, performAISearch, clearSearchResults };
}
