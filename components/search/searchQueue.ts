import { comparisonKey, type ComparisonResult, type SearchResult, type VocabCard } from '../../types';
import type { PendingRequest, SearchFailure, SearchRequest } from '../../services/searchRecovery';

/**
 * The search queue as data: every lookup, comparison and sentence scan the search button runs, and the state changes
 * it goes through. Lookups and comparisons share the queue, so every count of results includes both; a scan only
 * finds the expressions it queues as lookups, so it shows no result and counts only towards being busy. The
 * functions here are pure, apart from the counts the refresh log keeps; useSearchQueue runs the requests and applies
 * their outcomes through searchQueueReducer.
 */

/** One entry of the search queue: a lookup, a comparison or a scan, from the moment it's asked for until it's dismissed. */
export interface QueueItem {
  id: string;
  kind: 'lookup' | 'compare' | 'scan';   // 'lookup' = analyze a word; 'compare' = compare 2+ words; 'scan' = find a
                                         // sentence's uncommon expressions and look each one up
  query: string;                         // lookup: the query; compare: "a vs b" for display; scan: the sentence
  status: 'pending' | 'searching' | 'ready' | 'failed'; // a scan is 'ready' once it has finished
  results: SearchResult | null;          // search result
  words?: string[];                      // compare: the words being compared
  comparison?: ComparisonResult | null;  // compare result
  forceAI?: boolean; // refresh: re-run the AI, bypassing the saved-card reuse
  refreshing?: boolean; // in-place refresh in flight: keep showing the old results with a spinner
  analyzeMode?: 'batch'; // analyze as one entry, without re-splitting a multi-word idiom: an expression a scan found
                         // in a sentence, or a term picked on screen that reads like a sentence
  /** lookup: when its result opens in the sheet by itself (see OpenPolicy). */
  openOnReady?: OpenPolicy;
  /** When its request went out ('start'). A saved word is answered without one, so it has none. */
  startedAt?: number;
  /** When the lookup was last asked for again while it was still running. */
  repeatAt?: number;
  /** Whether the sheet has shown the result. The search button and the results pill count only the others. */
  seen: boolean;
  /** lookup: the scan that found this expression in a sentence. */
  scanId?: string;
  /** lookup: the sentence it came from (a scan's snippet, or the sentence a word was picked in), shown above its
   *  meanings. It stays on this device: never sent with the lookup, nor kept across a reload. */
  context?: string;
  /** scan, once finished: how many expressions it found, and the sentence in English when it was written in Chinese. */
  found?: number;
  translation?: string;
  /** scan: when it finished. */
  finishedAt?: number;
  /** Once it has failed: why, and what the error toast offers for it. */
  failure?: SearchFailure;
}

/**
 * When a lookup's result opens in the sheet by itself: 'saved-hit' only when the library answers it at once (a lookup
 * asked for directly), 'any' as soon as it's ready (a refresh), 'never' (an expression a scan found, or a request run
 * again after signing in or a reload). Other results wait for the user, on the search button. A retry keeps the
 * entry's policy.
 */
export type OpenPolicy = 'saved-hit' | 'any' | 'never';

export type QueueAction =
  /** A lookup of `query` (trimmed). A refresh (forceAI) replaces every entry for the same query; otherwise a
   *  duplicate that hasn't failed leaves the queue as it is, and a failed lookup of the query gives way to it. An
   *  expression a scan found carries the scan's id. Scans are never duplicates of a lookup, nor replaced by one. */
  | { type: 'add-search'; id: string; query: string; forceAI: boolean; analyzeMode?: 'batch'; scanId?: string; openOnReady: OpenPolicy; context?: string }
  /** A comparison of `words` (trimmed, two or more): ready at once when it was saved before. A failed comparison of
   *  the same words gives way to it. */
  | { type: 'add-compare'; id: string; words: string[]; cached: ComparisonResult | null }
  /** A scan of the sentence `query` (trimmed): nothing while a scan of it is still running; a failed one gives way. */
  | { type: 'add-scan'; id: string; query: string }
  /** The request went out, at `at`. */
  | { type: 'start'; id: string; at: number }
  | { type: 'search-ready'; id: string; results: SearchResult }
  | { type: 'compare-ready'; id: string; comparison: ComparisonResult }
  /** The scan finished at `at`, finding `found` expressions; `translation` is the sentence in English, if it was Chinese. */
  | { type: 'scan-done'; id: string; found: number; translation?: string; at: number }
  /** The request failed; the entry keeps why until it's retried or dismissed. */
  | { type: 'fail'; id: string; failure: SearchFailure }
  /** Every failure that retrying could fix goes back to pending, in its place and its own mode, to run again. */
  | { type: 'retry-failed' }
  /** Drops every failed entry. */
  | { type: 'dismiss-failed' }
  /** An in-place refresh of a ready lookup: it keeps showing the old result until the fresh one arrives. */
  | { type: 'refresh-start'; id: string }
  | { type: 'refresh-ready'; id: string; query: string; results: SearchResult }
  | { type: 'refresh-fail'; id: string }
  | { type: 'dismiss'; id: string }
  /** Clear all: drops every finished entry (ready or failed) and keeps the ones still running. */
  | { type: 'clear-finished' }
  /** The sheet has shown the result. */
  | { type: 'mark-seen'; id: string }
  /** The lookup was asked for again, at `at`, while it was still running. */
  | { type: 'repeat-asked'; id: string; at: number };

/** A query as the queue matches it: case doesn't count. */
const queryKey = (query: string): string => query.toLowerCase();
const sameQuery = (a: string, b: string): boolean => queryKey(a) === queryKey(b);

const patch = (queue: QueueItem[], id: string, fields: Partial<QueueItem>): QueueItem[] =>
  queue.map(item => item.id === id ? { ...item, ...fields } : item);

/** Queued, or waiting on its answer. */
const isRunning = (item: QueueItem): boolean => item.status === 'pending' || item.status === 'searching';

/** Whether a lookup of `query` would duplicate a lookup or comparison still running or ready (case-insensitively). */
export const hasLiveDuplicate = (queue: readonly QueueItem[], query: string): boolean =>
  queue.some(item => item.kind !== 'scan' && sameQuery(item.query, query) && item.status !== 'failed');

export function searchQueueReducer(queue: QueueItem[], action: QueueAction): QueueItem[] {
  switch (action.type) {
    case 'add-search': {
      const { id, query, forceAI, analyzeMode, scanId, openOnReady, context } = action;
      if (!forceAI && hasLiveDuplicate(queue, query)) return queue;
      const replaces = forceAI
        ? (item: QueueItem) => item.kind !== 'scan' && sameQuery(item.query, query)
        : (item: QueueItem) => item.kind === 'lookup' && item.status === 'failed' && sameQuery(item.query, query);
      return [
        ...queue.filter(item => !replaces(item)),
        {
          id, kind: 'lookup', query, status: 'pending', results: null, seen: false, forceAI, analyzeMode, openOnReady,
          ...(scanId ? { scanId } : {}), ...(context ? { context } : {}),
        },
      ];
    }
    case 'add-compare': {
      const { id, words, cached } = action;
      const key = comparisonKey(words);
      return [...queue.filter(item => !(item.kind === 'compare' && item.status === 'failed' && comparisonKey(item.words || []) === key)), {
        id, kind: 'compare', query: words.join(' vs '), words,
        status: cached ? 'ready' : 'pending', results: null, comparison: cached, seen: false,
      }];
    }
    case 'add-scan': {
      const { id, query } = action;
      const scanOf = (item: QueueItem) => item.kind === 'scan' && sameQuery(item.query, query);
      if (queue.some(item => scanOf(item) && isRunning(item))) return queue;
      return [
        ...queue.filter(item => !(scanOf(item) && item.status === 'failed')),
        { id, kind: 'scan', query, status: 'pending', results: null, seen: false },
      ];
    }
    case 'start':
      return patch(queue, action.id, { status: 'searching', startedAt: action.at });
    case 'search-ready':
      return patch(queue, action.id, { status: 'ready', results: action.results });
    case 'compare-ready':
      return patch(queue, action.id, { status: 'ready', comparison: action.comparison });
    case 'scan-done': {
      const { found, translation, at } = action;
      return patch(queue, action.id, { status: 'ready', found, ...(translation ? { translation } : {}), finishedAt: at });
    }
    case 'fail':
      return patch(queue, action.id, { status: 'failed', failure: action.failure });
    case 'retry-failed':
      return queue.map(item => {
        if (item.status !== 'failed' || !item.failure?.retryable) return item;
        const { failure: _failure, startedAt: _startedAt, repeatAt: _repeatAt, ...asked } = item;
        return { ...asked, status: 'pending' };
      });
    case 'dismiss-failed':
      return queue.filter(item => item.status !== 'failed');
    case 'refresh-start':
      return patch(queue, action.id, { refreshing: true });
    case 'refresh-ready':
      // The fresh result is new to the user until the sheet shows it, which it does at once if it's open on it.
      return patch(queue, action.id, { status: 'ready', results: action.results, query: action.query, refreshing: false, seen: false });
    case 'refresh-fail':
      return patch(queue, action.id, { refreshing: false });
    case 'dismiss':
      return queue.filter(item => item.id !== action.id);
    case 'clear-finished':
      return queue.filter(isRunning);
    case 'mark-seen':
      return patch(queue, action.id, { seen: true });
    case 'repeat-asked':
      return patch(queue, action.id, { repeatAt: action.at });
  }
}

/** The state update that applies `action`, for a queue held in React state: `setQueue(queueUpdate(action))`. */
export const queueUpdate = (action: QueueAction) => (queue: QueueItem[]): QueueItem[] => searchQueueReducer(queue, action);

/** Whether the entry `id` is still in the queue (a refresh of the same word replaces it, a dismissal drops it). */
export const isQueued = (queue: readonly QueueItem[], id: string): boolean => queue.some(item => item.id === id);

/**
 * The lookup of `query` still running or ready, if any, matched trimmed and whatever its case: what asking for the
 * word again finds.
 */
export const findLiveLookup = (queue: readonly QueueItem[], query: string): QueueItem | undefined =>
  queue.find(item => item.kind === 'lookup' && item.status !== 'failed' && sameQuery(item.query, query.trim()));

/**
 * What asking again for `query` does: 'open' its ready result, say it's still 'running', or queue a 'new' lookup
 * when none is live (a failed one is asked for again). Only lookups count, not comparisons or sentence scans.
 */
export function classifyEnqueue(queue: readonly QueueItem[], query: string): 'open' | 'running' | 'new' {
  const live = findLiveLookup(queue, query);
  return !live ? 'new' : live.status === 'ready' ? 'open' : 'running';
}

/**
 * The refreshes (forced lookups) asked for so far, by query. A forced lookup replaces every entry for its query, so a
 * request whose entry's query has been refreshed since the request started belongs to a replaced entry, whether the
 * entry was still queued or the user had already dismissed it.
 */
export function createRefreshLog() {
  const counts = new Map<string, number>();
  const countOf = (key: string): number => counts.get(key) ?? 0;
  return {
    /** A forced lookup of `query` was asked for. */
    note(query: string): void {
      const key = queryKey(query);
      counts.set(key, countOf(key) + 1);
    },
    /** A check for later: whether a forced lookup of `query` has been asked for since this call. */
    watch(query: string): () => boolean {
      const key = queryKey(query);
      const seen = countOf(key);
      return () => countOf(key) !== seen;
    },
  };
}

/** The results the sheet can show, in the order they were asked for: ready lookups and comparisons. */
export const readyItemsOf = (queue: readonly QueueItem[]): QueueItem[] =>
  queue.filter(item => item.status === 'ready' && item.kind !== 'scan');

/** The ready results the sheet hasn't shown yet: what the search button and the results pill count. */
export const unseenReadyCount = (queue: readonly QueueItem[]): number => readyItemsOf(queue).filter(item => !item.seen).length;

/** Where opening the results starts: the first one not seen yet, in the order they were asked for, else the newest. */
export function openIndexForResults(readyItems: readonly QueueItem[]): number {
  const unseen = readyItems.findIndex(item => !item.seen);
  return unseen >= 0 ? unseen : Math.max(0, readyItems.length - 1);
}

/** Lookups and comparisons waiting for their request or waiting on it: the count the button and the sheet show. */
export const runningCountOf = (queue: readonly QueueItem[]): number =>
  queue.filter(item => item.kind !== 'scan' && isRunning(item)).length;

/** Whether anything is still running, sentence scans included: the button spins until each one has finished. */
export const isBusyOf = (queue: readonly QueueItem[]): boolean => queue.some(isRunning);

/** How long the error toast shows a failure that neither retrying nor editing could fix. */
export const PASSING_FAILURE_MS = 6000;

type FailedItem = QueueItem & { failure: SearchFailure };

/** A failure stays until it's acted on when Retry or Edit could fix it; any other passes after PASSING_FAILURE_MS. */
const lasts = (failure: SearchFailure): boolean => failure.retryable || failure.notAWord;

const failuresShownAt = (queue: readonly QueueItem[], now: number): FailedItem[] =>
  queue.filter((item): item is FailedItem => item.status === 'failed' && !!item.failure
    && (lasts(item.failure) || now < item.failure.at + PASSING_FAILURE_MS));

/** What the error toast shows for the failures in the queue. */
export interface FailureSummary {
  /** The newest failure: its message leads the toast, and Edit puts its query back in the box. */
  newest: FailedItem;
  /** How many other failures are shown behind it. */
  others: number;
  /** What the toast offers besides ×, following the newest failure: running it again ('retry'), with every other
   *  failure retrying could fix ('retry-all'), editing a query the model found no entry for ('edit'), or nothing. */
  action: 'retry' | 'retry-all' | 'edit' | null;
}

/** The failures the error toast shows at `now`, or null when there are none. */
export function summarizeFailures(queue: readonly QueueItem[], now: number): FailureSummary | null {
  const shown = failuresShownAt(queue, now);
  if (shown.length === 0) return null;
  const newest = shown.reduce((latest, item) => (item.failure.at >= latest.failure.at ? item : latest));
  const retryable = shown.filter(item => item.failure.retryable).length;
  const action = newest.failure.notAWord ? 'edit'
    : newest.failure.retryable ? (retryable > 1 ? 'retry-all' : 'retry')
    : null;
  return { newest, others: shown.length - 1, action };
}

/** When the next passing failure leaves the error toast, after `now`, or null when none will. */
export function nextFailureExpiry(queue: readonly QueueItem[], now: number): number | null {
  let next: number | null = null;
  for (const { failure } of failuresShownAt(queue, now)) {
    if (lasts(failure)) continue;
    const expiry = failure.at + PASSING_FAILURE_MS;
    if (next === null || expiry < next) next = expiry;
  }
  return next;
}

/** The request an entry stands for, to run it again: its query and mode, never its result or the sentence it came from. */
export function requestOf(item: QueueItem): SearchRequest {
  if (item.kind === 'scan') return { kind: 'scan', query: item.query };
  if (item.kind === 'compare') return { kind: 'compare', words: item.words || [] };
  return {
    kind: 'analyze',
    query: item.query,
    ...(item.analyzeMode ? { analyzeMode: item.analyzeMode } : {}),
    ...(item.forceAI ? { forceAI: true } : {}),
  };
}

/**
 * What a reload would lose, in the order it was asked for: the lookups and comparisons still running or whose results
 * haven't been seen, and the scans still running (a finished scan's expressions are lookups of their own). Each goes
 * with when its request went out, or `now` for one that hasn't yet or never needed one.
 */
export const pendingRequestsOf = (queue: readonly QueueItem[], now: number): PendingRequest[] =>
  queue
    .filter(item => isRunning(item) || (item.status === 'ready' && item.kind !== 'scan' && !item.seen))
    .map(item => ({ request: requestOf(item), at: item.startedAt ?? now }));

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
