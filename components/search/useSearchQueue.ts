import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { comparisonKey, type ComparisonResult, type VocabCard } from '../../types';
import { analyzeInput, compareWords, detectVocabulary } from '../../services/api/ai';
import { ensureTTS } from '../../services/neuralTts';
import { log, warn } from '../../services/logger';
import { consumeSearchRetry, describeSearchError, isAuthenticationError, isRetryableSearchError, rememberSearchRetry } from '../../services/searchRecovery';
// The analysis route makes the same call, so a query the box treats as a word is analyzed as one.
import { looksLikeSentence } from '../../services/queryMode';
import { useLatest } from '../../hooks/useStableValue';
import { subscribeSearchRequests, type CompareRequest, type LookupRequest } from '../../services/searchRequests';
import { routeLookup } from './searchRouting';
import { runLookup } from './runLookup';
import {
  createRefreshLog, findLiveComparison, findLiveLookup, isBusyOf, isQueued, queueUpdate, readyItemsOf, runningCountOf,
  savedCardsResult, searchQueueReducer, unseenReadyCount, type OpenPolicy, type QueueAction, type QueueItem,
} from './searchQueue';

let queueIdCounter = 0;

/** What a lookup or a comparison that needs the network says when the device is offline. */
const OFFLINE_LOOKUP = "You're offline, so only saved words can be looked up.";
const OFFLINE_COMPARE = "You're offline, so only saved comparisons can be opened.";

interface Options {
  findSavedByWord: (word: string) => VocabCard[];
  isOnline: boolean;
  /** Replace an already-saved word's card(s) with a freshly re-run AI result (refresh). Keeps SRS. */
  onRefreshReplace?: (word: string, vocabs: VocabCard[]) => void;
  /** A finished comparison — persist it (server + local) so it shows on each involved word's page. */
  onCompareReady?: (words: string[], result: ComparisonResult) => void;
  /** Open this entry in the results sheet once it's ready: a saved word, a refresh, a saved comparison, or a word
   *  asked for again whose result is ready. */
  openWhenReady: (id: string) => void;
  showError: (msg: string, query?: string, analyzeMode?: 'batch') => void;
  clearError: () => void;
  showStatus: (msg: string) => void;
}

/**
 * The search queue's lifecycle. Lookups, comparisons and sentence scans join it from the search box, from the rest of
 * the app (services/searchRequests and, until App switches to it, the window's 'global-search' event), and from a
 * resume after signing in again; every pending entry starts at once and runs once; each settles as ready, opening in
 * the sheet when that was asked for, or as failed, with the error toast. A finished scan queues a lookup of each
 * expression it found.
 */
export function useSearchQueue({
  findSavedByWord, isOnline, onRefreshReplace, onCompareReady, openWhenReady, showError, clearError, showStatus,
}: Options) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const processingIdsRef = useRef<Set<string>>(new Set()); // prevents a re-render from starting an item twice
  const queueRef = useLatest(queue); // the latest queue, for checks outside a render (asking again, a superseded request)
  const [refreshLog] = useState(createRefreshLog); // the forced lookups asked for, so an in-place refresh knows it was replaced

  // Add a lookup of `q` to the queue, to be analyzed (see processItem) and opened by itself as `openOnReady` says.
  // forceAI = a refresh: re-run the AI even if the word is saved, and replace any existing queue entry for it so the
  // fresh result supersedes the old/reused one. A duplicate of a lookup still running or ready is skipped.
  const enqueue = useCallback((q: string, opts: { forceAI?: boolean; analyzeMode?: 'batch'; scanId?: string; openOnReady: OpenPolicy }) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const forceAI = !!opts.forceAI;
    const { analyzeMode, scanId, openOnReady } = opts;
    const id = `q-${++queueIdCounter}`;
    if (forceAI) refreshLog.note(trimmed);
    setQueue(prev => {
      const next = searchQueueReducer(prev, { type: 'add-search', id, query: trimmed, forceAI, analyzeMode, scanId, openOnReady });
      if (next === prev) log('🔍 Queue: skipping duplicate "' + trimmed + '"');
      else log('🔍 Queue: adding "' + trimmed + '"' + (forceAI ? ' (force refresh)' : '') + (analyzeMode ? ' (' + analyzeMode + ')' : ''));
      return next;
    });
  }, [refreshLog]);

  // A typed sentence is first scanned for its uncommon expressions, and each is then queued for its OWN full analysis
  // (batch mode), so they show up in the popup exactly like manually-searched words — to browse and save. Chinese is
  // translated to English inside the scan. The scan is a queue entry of its own (see processItem), so overlapping
  // scans each keep the button busy.
  const scan = useCallback((q: string) => {
    const id = `q-${++queueIdCounter}`;
    setQueue(prev => {
      const next = searchQueueReducer(prev, { type: 'add-scan', id, query: q });
      log(next === prev ? '🔍 Queue: already scanning "' + q + '"' : '🔍 Queue: scanning "' + q + '"');
      return next;
    });
  }, []);

  // A lookup asked for anywhere: typed in the box, picked on screen, or a refresh. Asking again for a word whose result
  // is ready opens it, and for one still running says so instead of sending it again; neither needs the network.
  // Otherwise routeLookup decides how it runs, the same way for every entry point: a direct lookup opens by itself
  // only when the library answers it, a refresh as soon as it's ready. Returns false when the device is offline and
  // the lookup needs the network, after saying so.
  const findSavedByWordRef = useLatest(findSavedByWord);
  const isOnlineRef = useLatest(isOnline);
  const lookUp = useCallback((request: LookupRequest): boolean => {
    const query = request.query.trim();
    if (!query) return true;
    const live = request.forceAI ? undefined : findLiveLookup(queueRef.current, query);
    if (live?.status === 'ready') {
      log('🔍 Queue: opening "' + query + '", already looked up');
      openWhenReady(live.id);
      return true;
    }
    if (live) {
      log('🔍 Queue: "' + query + '" is still being looked up');
      setQueue(queueUpdate({ type: 'repeat-asked', id: live.id, at: Date.now() }));
      showStatus(`Still looking up “${query}”…`);
      return true;
    }
    const route = routeLookup(request, {
      online: isOnlineRef.current,
      saved: findSavedByWordRef.current(query).length > 0,
      sentence: looksLikeSentence(query),
    });
    if (route.kind === 'offline') {
      showError(OFFLINE_LOOKUP);
      return false;
    }
    if (route.kind === 'scan') scan(query);
    else enqueue(query, { forceAI: route.forceAI, analyzeMode: route.analyzeMode, openOnReady: route.forceAI ? 'any' : 'saved-hit' });
    return true;
  }, [queueRef, isOnlineRef, findSavedByWordRef, openWhenReady, showStatus, showError, scan, enqueue]);

  // OAuth redirects preserve sessionStorage. Resume the exact failed query once the user signs in again.
  useEffect(() => {
    const retry = consumeSearchRetry();
    if (retry) enqueue(retry.query, { forceAI: true, analyzeMode: retry.analyzeMode, openOnReady: 'any' });
  }, [enqueue]);

  // Add a comparison to the SAME queue as searches. With a saved result it drops in as 'ready' and opens at once;
  // otherwise it's 'pending' and generates in the background like a search, which needs the network.
  const enqueueCompare = useCallback(({ words, cached }: CompareRequest) => {
    const clean = words.map(w => w.trim()).filter(Boolean);
    if (clean.length < 2) return;
    const key = comparisonKey(clean);
    const existing = findLiveComparison(queueRef.current, key);
    if (existing) {
      if (existing.status === 'ready') openWhenReady(existing.id); // already done → just open it
      return; // already queued/generating → don't duplicate
    }
    if (!cached && !isOnlineRef.current) {
      showError(OFFLINE_COMPARE);
      return;
    }
    const id = `q-${++queueIdCounter}`;
    log('⚖️ Queue: comparing "' + clean.join(' vs ') + '"' + (cached ? ' (saved)' : ''));
    setQueue(queueUpdate({ type: 'add-compare', id, words: clean, cached }));
    if (cached) openWhenReady(id); // saved comparison → open instantly in the popup
  }, [queueRef, isOnlineRef, openWhenReady, showError]);

  // What every AI lookup reads and changes beyond its own queue entry (see runLookup). The library is read through a
  // ref, as it is when a request settles, not as it was when the request started. The audio is generated if it
  // isn't cached yet, so the first play is instant.
  const lookupEffects = useMemo(() => ({
    analyze: (query: string, analyzeMode?: 'batch') => analyzeInput(query, analyzeMode ? { mode: analyzeMode } : undefined),
    savedCards: (word: string) => findSavedByWordRef.current(word),
    prepareAudio: ensureTTS,
    replaceSaved: onRefreshReplace,
    showError,
  }), [findSavedByWordRef, onRefreshReplace, showError]);

  // Process a single queue item: comparison, saved-card reuse, or a fresh analyze. The id was added to
  // processingIdsRef by the driver effect before this ran; every terminal path calls done().
  const processItem = useCallback((item: QueueItem) => {
    const itemId = item.id;
    const done = () => { processingIdsRef.current.delete(itemId); };

    // A sentence scan finds the sentence's uncommon expressions and queues a lookup of each.
    if (item.kind === 'scan') {
      const q = item.query;
      setQueue(queueUpdate({ type: 'start', id: itemId, at: Date.now() }));
      detectVocabulary(q).then(({ words, translation, sourceLang }) => {
        const english = sourceLang === 'zh' && translation ? translation : undefined;
        setQueue(queueUpdate({ type: 'scan-done', id: itemId, found: words.length, translation: english, at: Date.now() }));
        if (words.length === 0) {
          showStatus('No advanced expressions found in that sentence.');
          return;
        }
        const n = words.length;
        const noun = n === 1 ? 'expression' : 'expressions';
        showStatus(english ? `“${english}” — analyzing ${n} ${noun}…` : `Found ${n} ${noun} — analyzing…`);
        for (const w of words) enqueue(w.word, { analyzeMode: 'batch', scanId: itemId, openOnReady: 'never' });
      }).catch(err => {
        warn('🔍 Sentence scan failed "' + q + '":', (err as Error | undefined)?.message);
        setQueue(queueUpdate({ type: 'fail', id: itemId }));
        if (isAuthenticationError(err)) rememberSearchRetry({ query: q });
        showError(describeSearchError(q, err), isRetryableSearchError(err) ? q : undefined);
      }).finally(done);
      return;
    }

    // Comparison items run compareWords and persist on success.
    if (item.kind === 'compare') {
      setQueue(queueUpdate({ type: 'start', id: itemId, at: Date.now() }));
      log('⚖️ Queue: generating comparison "' + item.query + '"');
      compareWords(item.words || []).then(result => {
        clearError();
        setQueue(queueUpdate({ type: 'compare-ready', id: itemId, comparison: result }));
        onCompareReady?.(item.words || [], result); // persist (server + local) for the word pages
      }).catch(err => {
        warn('⚖️ Queue: compare failed "' + item.query + '":', err?.message);
        setQueue(queueUpdate({ type: 'fail', id: itemId }));
        showError(describeSearchError(item.query, err), undefined);
      }).finally(done);
      return;
    }

    // Reuse the saved card to skip the API call — UNLESS this is a refresh (forceAI), which must
    // always re-run the AI (otherwise "refresh" would just show the same saved card again).
    const savedVocabs = item.forceAI ? [] : findSavedByWord(item.query);
    if (savedVocabs.length > 0) {
      log('🔍 Queue: "' + item.query + '" already saved (' + savedVocabs.length + ' meanings), skipping API');
      setQueue(queueUpdate({ type: 'search-ready', id: itemId, results: savedCardsResult(itemId, item.query, savedVocabs, Date.now()) }));
      if (item.openOnReady !== 'never') openWhenReady(itemId); // a direct lookup opens; a scan's expressions accumulate
      done();
      return;
    }

    // Mark as searching
    setQueue(queueUpdate({ type: 'start', id: itemId, at: Date.now() }));

    log('🔍 Queue: searching "' + item.query + '"' + (item.analyzeMode ? ' (' + item.analyzeMode + ')' : ''));
    void runLookup({ query: item.query, analyzeMode: item.analyzeMode, refresh: !!item.forceAI }, {
      ...lookupEffects,
      // A refresh of the same word replaces this entry while its request runs; the outcome then belongs to the
      // newer request, so this one changes nothing: no toast, no queue change, no saved-card write.
      isCurrent: () => isQueued(queueRef.current, itemId),
      showResult: result => {
        clearError(); // a fresh success clears any lingering failure toast
        setQueue(queueUpdate({ type: 'search-ready', id: itemId, results: result }));
        if (item.openOnReady === 'any') openWhenReady(itemId); // refresh → open the fresh result (like the reuse path auto-opens)
      },
      showFailure: () => setQueue(queueUpdate({ type: 'fail', id: itemId })),
    }).finally(done);
  }, [findSavedByWord, lookupEffects, showError, showStatus, enqueue, onCompareReady, openWhenReady, clearError, queueRef]);

  // The results sheet's refresh button: re-run the AI for `word` and swap the fresh result into `item` in place,
  // keeping its current result on screen (with a spinner) meanwhile, rather than clearing the entry, which blanked
  // the sheet until the AI answered. Like any refresh, it replaces the word's saved cards. `onFresh` runs once the
  // fresh result is in the entry.
  const refreshInPlace = useCallback((item: QueueItem, word: string, onFresh: () => void) => {
    const query = word.trim();
    if (!query || item.refreshing) return;
    const { id, analyzeMode } = item;
    setQueue(queueUpdate({ type: 'refresh-start', id }));
    // A forced lookup of the entry's query (a refresh from a word's page, say) replaces the entry; the outcome then
    // belongs to that newer request, so this one changes nothing. An entry the user dismissed or cleared still saves
    // its result and reports its failure: the user asked for that refresh.
    const replaced = refreshLog.watch(item.query);
    // An expression taken from a sentence is refreshed as the same unit, not re-split into its words.
    void runLookup({ query, analyzeMode, refresh: true }, {
      ...lookupEffects,
      isCurrent: () => !replaced(),
      showResult: results => {
        setQueue(queueUpdate({ type: 'refresh-ready', id, query, results }));
        onFresh();
      },
      showFailure: () => setQueue(queueUpdate({ type: 'refresh-fail', id })),
    });
  }, [lookupEffects, refreshLog]);

  // Driver: start every pending text-model job immediately. DeepInfra owns provider capacity; locally we
  // only de-duplicate starts so a re-render while a request is in flight cannot submit the same item twice.
  useEffect(() => {
    for (const item of queue) {
      if (item.status !== 'pending' || processingIdsRef.current.has(item.id)) continue;
      processingIdsRef.current.add(item.id);
      processItem(item);
    }
  }, [queue, processItem]);

  // Requests from the rest of the app (services/searchRequests), including the ones made before the search loaded.
  // They go through refs, so the subscription lasts as long as the search does.
  const lookUpRef = useLatest(lookUp);
  const enqueueCompareRef = useLatest(enqueueCompare);
  useEffect(() => subscribeSearchRequests({
    lookup: request => { lookUpRef.current(request); },
    compare: request => enqueueCompareRef.current(request),
  }), [lookUpRef, enqueueCompareRef]);

  // wave-2 adapter: remove in P3
  // App's lookups (a tapped word, a term's button, a refresh) and the Notebook row's Refresh still arrive as this window
  // event until they call requestLookup. Each one is an expression picked on screen, as their requests will say.
  useEffect(() => {
    const onWindowLookup = (e: Event) => {
      const detail = (e as CustomEvent<{ query?: unknown; forceAI?: unknown } | null>).detail;
      if (typeof detail?.query === 'string') lookUpRef.current({ query: detail.query, source: 'expression', forceAI: !!detail.forceAI });
    };
    window.addEventListener('global-search', onWindowLookup);
    return () => window.removeEventListener('global-search', onWindowLookup);
  }, [lookUpRef]);

  // Derived state — searches AND comparisons are both queue items, so every count of results includes both; a scan
  // running keeps the search busy without adding to the count.
  const readyItems = useMemo(() => readyItemsOf(queue), [queue]);
  const unseenCount = unseenReadyCount(queue);
  const runningCount = runningCountOf(queue);
  const isBusy = isBusyOf(queue);
  // Applies a state change GlobalSearch makes itself: a dismissal, Clear all, a result shown.
  const updateQueue = useCallback((action: QueueAction) => setQueue(queueUpdate(action)), []);

  return { queue, readyItems, unseenCount, runningCount, isBusy, updateQueue, enqueue, lookUp, refreshInPlace };
}
