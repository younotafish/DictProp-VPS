import type { ComparisonResult, SearchResult } from '../../types';

/** One entry of the search queue: a lookup or a comparison, from the moment it's asked for until it's dismissed. */
export interface QueueItem {
  id: string;
  kind: 'search' | 'compare';            // 'search' = analyze a word; 'compare' = compare 2+ words
  query: string;                         // search: the query; compare: "a vs b" for display
  status: 'pending' | 'searching' | 'ready' | 'failed';
  results: SearchResult | null;          // search result
  words?: string[];                      // compare: the words being compared
  comparison?: ComparisonResult | null;  // compare result
  forceAI?: boolean; // refresh: re-run the AI, bypassing the saved-card reuse
  refreshing?: boolean; // in-place refresh in flight: keep showing the old results with a spinner
  analyzeMode?: 'batch'; // expressions auto-extracted from a sentence search: analyze as a pre-identified
                         // unit (don't re-split multi-word idioms) and don't auto-open the popup.
}
