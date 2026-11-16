import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { comparisonKey, type ComparisonResult, type VocabCard } from '../../types';
import { analyzeInput, compareWords, detectVocabulary } from '../../services/api/ai';
import { ensureTTS } from '../../services/neuralTts';
import { log, warn } from '../../services/logger';
import { consumeSearchRetry, describeSearchError, isAuthenticationError, isRetryableSearchError, rememberSearchRetry } from '../../services/searchRecovery';
// The analysis route makes the same call, so a query the box treats as a word is analyzed as one.
import { looksLikeSentence } from '../../services/queryMode';
import { useLatest } from '../../hooks/useStableValue';
import { runLookup } from './runLookup';
import {
  busyCountOf, createRefreshLog, findLiveComparison, findLiveLookup, isQueued, queueUpdate, readyItemsOf, savedCardsResult,
  searchQueueReducer, unseenReadyCount, type QueueAction, type QueueItem,
} from './searchQueue';

let queueIdCounter = 0;

interface Options {
  findSavedByWord: (word: string) => VocabCard[];
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
 * The search queue's lifecycle. Lookups and comparisons join it from the search box, from the window's
 * 'global-search' and 'global-compare' events, and from a resume after signing in again; every pending entry
 * starts at once and runs once; each settles as ready, opening in the sheet when that was asked for, or as
 * failed, with the error toast.
 */
export function useSearchQueue({
  findSavedByWord, onRefreshReplace, onCompareReady, openWhenReady, showError, clearError, showStatus,
}: Options) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const processingIdsRef = useRef<Set<string>>(new Set()); // prevents a re-render from starting an item twice
  const queueRef = useLatest(queue); // the latest queue, for checks outside a render (asking again, a superseded request)
  const [scanning, setScanning] = useState(false); // sentence → expression scan in flight (pre-enqueue)
  const [refreshLog] = useState(createRefreshLog); // the forced lookups asked for, so an in-place refresh knows it was replaced

  // Add a query to the queue. forceAI = a refresh: re-run the AI even if the word is saved, and
  // replace any existing queue entry for it so the fresh result supersedes the old/reused one.
  // Asking again for a word whose result is ready opens it, and for one still running says so instead of sending it
  // again. An expression found in a sentence never opens by itself, so its repeat is only skipped.
  const enqueue = useCallback((q: string, opts?: { forceAI?: boolean; analyzeMode?: 'batch' }) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const forceAI = !!opts?.forceAI;
    const analyzeMode = opts?.analyzeMode;
    const live = forceAI || analyzeMode ? undefined : findLiveLookup(queueRef.current, trimmed);
    if (live?.status === 'ready') {
      log('🔍 Queue: opening "' + trimmed + '", already looked up');
      openWhenReady(live.id);
      return;
    }
    if (live) {
      log('🔍 Queue: "' + trimmed + '" is still being looked up');
      setQueue(queueUpdate({ type: 'repeat-asked', id: live.id, at: Date.now() }));
      showStatus(`Still looking up “${trimmed}”…`);
      return;
    }
    const id = `q-${++queueIdCounter}`;
    if (forceAI) refreshLog.note(trimmed);
    setQueue(prev => {
      const next = searchQueueReducer(prev, { type: 'add-search', id, query: trimmed, forceAI, analyzeMode });
      if (next === prev) log('🔍 Queue: skipping duplicate "' + trimmed + '"');
      else log('🔍 Queue: adding "' + trimmed + '"' + (forceAI ? ' (force refresh)' : '') + (analyzeMode ? ' (' + analyzeMode + ')' : ''));
      return next;
    });
  }, [queueRef, refreshLog, openWhenReady, showStatus]);

  // OAuth redirects preserve sessionStorage. Resume the exact failed query once the user signs in again.
  useEffect(() => {
    const retry = consumeSearchRetry();
    if (retry) enqueue(retry.query, { forceAI: true, analyzeMode: retry.analyzeMode });
  }, [enqueue]);

  // Add a comparison to the SAME queue as searches. With a cachedResult (already saved) it drops in as
  // 'ready' and auto-opens; otherwise it's 'pending' and generates in the background like a search.
  const enqueueCompare = useCallback((words: string[], cachedResult?: ComparisonResult | null) => {
    const clean = words.map(w => w.trim()).filter(Boolean);
    if (clean.length < 2) return;
    const key = comparisonKey(clean);
    const existing = findLiveComparison(queueRef.current, key);
    if (existing) {
      if (existing.status === 'ready') openWhenReady(existing.id); // already done → just open it
      return; // already queued/generating → don't duplicate
    }
    const id = `q-${++queueIdCounter}`;
    log('⚖️ Queue: comparing "' + clean.join(' vs ') + '"' + (cachedResult ? ' (saved)' : ''));
    setQueue(queueUpdate({ type: 'add-compare', id, words: clean, cached: cachedResult ?? null }));
    if (cachedResult) openWhenReady(id); // saved comparison → open instantly in the popup
  }, [queueRef, openWhenReady]);

  // Typed-search entry. A single word/short phrase analyzes directly (current behavior). A full sentence
  // is first scanned for its uncommon expressions, and each is then queued for its OWN full analysis
  // (batch mode), so they show up in the popup exactly like manually-searched words — to browse and save.
  // Chinese is translated to English inside the scan; a Chinese word/short phrase still analyzes directly.
  const submitQuery = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    if (!looksLikeSentence(q)) {
      enqueue(q); // word / short phrase → current direct path (one card set)
      return;
    }
    setScanning(true);
    try {
      const { words, translation, sourceLang } = await detectVocabulary(q);
      if (words.length === 0) {
        showStatus('No advanced expressions found in that sentence.');
        return;
      }
      const n = words.length;
      const noun = n === 1 ? 'expression' : 'expressions';
      showStatus(
        sourceLang === 'zh' && translation
          ? `“${translation}” — analyzing ${n} ${noun}…`
          : `Found ${n} ${noun} — analyzing…`
      );
      for (const w of words) enqueue(w.word, { analyzeMode: 'batch' });
    } catch (err) {
      warn('🔍 Sentence scan failed "' + q + '":', (err as Error | undefined)?.message);
      if (isAuthenticationError(err)) rememberSearchRetry({ query: q });
      showError(describeSearchError(q, err), isRetryableSearchError(err) ? q : undefined);
    } finally {
      setScanning(false);
    }
  }, [enqueue, showError, showStatus]);

  // What every AI lookup reads and changes beyond its own queue entry (see runLookup). The library is read through a
  // ref, as it is when a request settles, not as it was when the request started. The audio is generated if it
  // isn't cached yet, so the first play is instant.
  const findSavedByWordRef = useLatest(findSavedByWord);
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
      if (!item.analyzeMode) openWhenReady(itemId); // direct DB hit auto-opens; sentence-expanded items just accumulate
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
        if (item.forceAI) openWhenReady(itemId); // refresh → open the fresh result (like the reuse path auto-opens)
      },
      showFailure: () => setQueue(queueUpdate({ type: 'fail', id: itemId })),
    }).finally(done);
  }, [findSavedByWord, lookupEffects, showError, onCompareReady, openWhenReady, clearError, queueRef]);

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

  // Listen for programmatic search triggers (e.g., from inline highlighted words)
  useEffect(() => {
    const handleTrigger = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const q = detail?.query;
      if (q && typeof q === 'string') {
        enqueue(q, { forceAI: !!detail?.forceAI });
      }
    };
    window.addEventListener('global-search', handleTrigger);
    return () => window.removeEventListener('global-search', handleTrigger);
  }, [enqueue]);

  // Listen for comparison triggers — same queue as search. detail = { words, result? } (result = cached).
  useEffect(() => {
    const handleCompareTrigger = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (Array.isArray(detail?.words)) enqueueCompare(detail.words, detail.result ?? null);
    };
    window.addEventListener('global-compare', handleCompareTrigger);
    return () => window.removeEventListener('global-compare', handleCompareTrigger);
  }, [enqueueCompare]);

  // Derived state — searches AND comparisons are both queue items, so all counts include both.
  const readyItems = useMemo(() => readyItemsOf(queue), [queue]);
  const unseenCount = unseenReadyCount(queue);
  const busyCount = busyCountOf(queue);
  // Applies a state change GlobalSearch makes itself: a dismissal, Clear all, a result shown.
  const updateQueue = useCallback((action: QueueAction) => setQueue(queueUpdate(action)), []);

  return { queue, readyItems, unseenCount, busyCount, scanning, updateQueue, enqueue, submitQuery, refreshInPlace };
}
