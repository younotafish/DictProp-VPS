import { comparisonKey, type ComparisonResult, type SearchResult, type VocabCard } from '../../types';

/**
 * The search queue as data: every lookup and comparison the search button runs, and the state changes it goes
 * through. Lookups and comparisons share the queue, so every count includes both. The functions here are pure;
 * useSearchQueue runs the requests and applies their outcomes through searchQueueReducer.
 */

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

export type QueueAction =
  /** A lookup of `query` (trimmed). A refresh (forceAI) replaces every entry for the same query; otherwise a
   *  duplicate that hasn't failed leaves the queue as it is. */
  | { type: 'add-search'; id: string; query: string; forceAI: boolean; analyzeMode?: 'batch' }
  /** A comparison of `words` (trimmed, two or more): ready at once when it was saved before. */
  | { type: 'add-compare'; id: string; words: string[]; cached: ComparisonResult | null }
  /** The request went out. */
  | { type: 'start'; id: string }
  | { type: 'search-ready'; id: string; results: SearchResult }
  | { type: 'compare-ready'; id: string; comparison: ComparisonResult }
  | { type: 'fail'; id: string }
  /** An in-place refresh of a ready lookup: it keeps showing the old result until the fresh one arrives. */
  | { type: 'refresh-start'; id: string }
  | { type: 'refresh-ready'; id: string; query: string; results: SearchResult }
  | { type: 'refresh-fail'; id: string }
  | { type: 'dismiss'; id: string }
  /** Clear all: drops every finished entry (ready or failed) and keeps the ones still running. */
  | { type: 'clear-finished' };

const sameQuery = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const patch = (queue: QueueItem[], id: string, fields: Partial<QueueItem>): QueueItem[] =>
  queue.map(item => item.id === id ? { ...item, ...fields } : item);

/** Whether a lookup of `query` would duplicate an entry still running or ready (case-insensitively). */
export const hasLiveDuplicate = (queue: readonly QueueItem[], query: string): boolean =>
  queue.some(item => sameQuery(item.query, query) && item.status !== 'failed');

export function searchQueueReducer(queue: QueueItem[], action: QueueAction): QueueItem[] {
  switch (action.type) {
    case 'add-search': {
      const { id, query, forceAI, analyzeMode } = action;
      if (!forceAI && hasLiveDuplicate(queue, query)) return queue;
      const base = forceAI ? queue.filter(item => !sameQuery(item.query, query)) : queue;
      return [...base, { id, kind: 'search', query, status: 'pending', results: null, forceAI, analyzeMode }];
    }
    case 'add-compare': {
      const { id, words, cached } = action;
      return [...queue, {
        id, kind: 'compare', query: words.join(' vs '), words,
        status: cached ? 'ready' : 'pending', results: null, comparison: cached,
      }];
    }
    case 'start':
      return patch(queue, action.id, { status: 'searching' });
    case 'search-ready':
      return patch(queue, action.id, { status: 'ready', results: action.results });
    case 'compare-ready':
      return patch(queue, action.id, { status: 'ready', comparison: action.comparison });
    case 'fail':
      return patch(queue, action.id, { status: 'failed' });
    case 'refresh-start':
      return patch(queue, action.id, { refreshing: true });
    case 'refresh-ready':
      return patch(queue, action.id, { status: 'ready', results: action.results, query: action.query, refreshing: false });
    case 'refresh-fail':
      return patch(queue, action.id, { refreshing: false });
    case 'dismiss':
      return queue.filter(item => item.id !== action.id);
    case 'clear-finished':
      return queue.filter(item => item.status === 'pending' || item.status === 'searching');
  }
}

/** The state update that applies `action`, for a queue held in React state: `setQueue(queueUpdate(action))`. */
export const queueUpdate = (action: QueueAction) => (queue: QueueItem[]): QueueItem[] => searchQueueReducer(queue, action);

/** The results the sheet can show, in the order they were asked for. */
export const readyItemsOf = (queue: readonly QueueItem[]): QueueItem[] => queue.filter(item => item.status === 'ready');

/** Lookups and comparisons waiting for their request or waiting on it. */
export const busyCountOf = (queue: readonly QueueItem[]): number =>
  queue.filter(item => item.status === 'searching' || item.status === 'pending').length;

/** The comparison of the word set `key` (a comparisonKey) that's queued, running or ready, if any. */
export const findLiveComparison = (queue: readonly QueueItem[], key: string): QueueItem | undefined =>
  queue.find(item => item.kind === 'compare' && comparisonKey(item.words || []) === key && item.status !== 'failed');

/** The result a lookup shows for a word already in the library: its saved cards, without asking the AI. */
export const savedCardsResult = (itemId: string, query: string, savedVocabs: VocabCard[], timestamp: number): SearchResult => ({
  id: 'saved-' + itemId,
  query,
  translation: '',
  grammar: '',
  visualKeyword: savedVocabs[0].word,
  pronunciation: savedVocabs[0].ipa || '',
  vocabs: savedVocabs,
  timestamp,
});
