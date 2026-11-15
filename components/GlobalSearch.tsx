import React, { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue, useId } from 'react';
import { SearchResult, VocabCard, StoredItem, ComparisonResult } from '../types';
import { analyzeInput } from '../services/api';
import { makeVocabStoredItem } from '../services/items';
import { speakWord, prefetchTTS, speakNatural, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, acquireKeepAlive, releaseKeepAlive } from '../services/lazyTts';
import { stripSentenceMarkers } from '../services/sentenceMarkers';
import { useSentenceSearch } from '../services/sentenceSearch';
import type { ZoneFlash } from './EyesFreeZones';
import { warn } from '../services/logger';
import { describeSearchError, isAuthenticationError, isRetryableSearchError, rememberSearchRetry } from '../services/searchRecovery';
import { useEscapeLayer } from './escapeStack';
import { isTypingTarget } from './keyboardTarget';
import { useModalFocus } from './Modal';
import { useOverlay } from './overlayStack';
// The analysis route makes the same call, so a query the box treats as a word is analyzed as one.
import { looksLikeSentence } from '../services/queryMode';
import { useSearchQueue } from './search/useSearchQueue';
import { SearchToasts, type SearchErrorToast } from './search/SearchToasts';
import { SearchInputBar } from './search/SearchInputBar';
import { SearchResultsSheet } from './search/SearchResultsSheet';
import { SearchVocabPane } from './search/SearchVocabPane';
import { SearchFab } from './search/SearchFab';

type Mode = 'idle' | 'input' | 'viewing';

interface Props {
  onSave: (item: StoredItem) => void;
  isVocabSaved: (vocab: VocabCard) => boolean;
  findSavedByWord: (word: string) => VocabCard[];
  onSearch: (text: string) => void;
  isOnline: boolean;
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>;
  /** Replace an already-saved word's card(s) with a freshly re-run AI result (refresh). Keeps SRS. */
  onRefreshReplace?: (word: string, vocabs: VocabCard[]) => void;
  /** Save an example sentence for review (shows the bookmark beside each USAGE megaphone). */
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
  /** A finished comparison — persist it (server + local) so it shows on each involved word's page. */
  onCompareReady?: (words: string[], result: ComparisonResult) => void;
  /** Compare from within a search-result card (parity with the notebook detail card). */
  onCompare?: (words: string[]) => void;
  /** Saved sentences to fuzzy-match as you type (autocomplete dropdown). */
  sentenceItems?: StoredItem[];
  /** Open a matched saved sentence for review (reuses the Sentences-tab open path). */
  onOpenSentence?: (ordered: StoredItem[], index: number) => void;
}

export const GlobalSearch: React.FC<Props> = ({ onSave, isVocabSaved, findSavedByWord, onSearch, isOnline, onLazyLoadImage, onRefreshReplace, onSaveSentence, isSentenceSaved, onCompareReady, onCompare, sentenceItems, onOpenSentence }) => {
  const [mode, setMode] = useState<Mode>('idle');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<SearchErrorToast | null>(null);
  // Viewing state: which queue item and which vocab within it
  const [viewingQueueIdx, setViewingQueueIdx] = useState(0);
  const [viewingVocabIdx, setViewingVocabIdx] = useState(0);
  // When a DB hit (already-saved word) becomes ready, auto-open its card. AI results don't set this.
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_THRESHOLD = 50;
  // Eyes-free zone tap-confirmation flash (see EyesFreeZones).
  const [zoneFlash, setZoneFlash] = useState<ZoneFlash | null>(null);
  const zoneFlashN = useRef(0);
  const zoneFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashZone = useCallback((zone: number) => {
    zoneFlashN.current += 1;
    setZoneFlash({ zone, n: zoneFlashN.current });
    if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current);
    zoneFlashTimer.current = setTimeout(() => setZoneFlash(null), 500);
  }, []);
  useEffect(() => () => { if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current); }, []);

  // Hold the audio session open while the results popup is open (once, on the first playback gesture) so
  // the media route stays "hot" across the word→sentence hop and iOS doesn't re-ramp (heard as a fade-in)
  // when the sentence <audio> starts after the word played on the speechSynthesis path. Closing the popup
  // lets go, or the silent keep-alive would run for the rest of the session.
  const keepAliveHeldRef = useRef(false);
  const holdKeepAlive = useCallback(() => {
    if (keepAliveHeldRef.current) return;
    keepAliveHeldRef.current = true;
    acquireKeepAlive();
  }, []);
  const letGoKeepAlive = useCallback(() => {
    if (!keepAliveHeldRef.current) return;
    keepAliveHeldRef.current = false;
    releaseKeepAlive();
  }, []);
  useEffect(() => { if (mode !== 'viewing') letGoKeepAlive(); }, [mode, letGoKeepAlive]);
  useEffect(() => letGoKeepAlive, [letGoKeepAlive]);

  // Surface a failed search as an auto-dismissing toast. The floating search has no inline results
  // area, so without this a failed queue item just vanishes (the bug behind silent search failures).
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showError = useCallback((msg: string, query?: string, analyzeMode?: 'batch') => {
    setError({ msg, query, analyzeMode });
    if (errorTimer.current) clearTimeout(errorTimer.current);
    // Search failures remain actionable until retried. Informational failures can still expire.
    errorTimer.current = query ? null : setTimeout(() => setError(null), 6000);
  }, []);
  useEffect(() => () => { if (errorTimer.current) clearTimeout(errorTimer.current); }, []);

  // Neutral status pill (top-center) — "scanning…/found N expressions" notices that aren't errors.
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showStatus = useCallback((msg: string) => {
    setStatusToast(msg);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatusToast(null), 3500);
  }, []);
  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);

  // Fuzzy autocomplete over SAVED SENTENCES: as you type, suggest matching saved sentences. Navigate
  // them with ↑/↓ or the mouse, and open one for review with Enter (on a highlight) or a click. Plain
  // Enter with nothing highlighted still runs the real AI search. Purely local (works offline).
  const runSentenceSearch = useSentenceSearch(sentenceItems || []);
  const deferredQuery = useDeferredValue(query);
  const suggestions = useMemo(
    () => (mode === 'input' && onOpenSentence && deferredQuery.trim() ? runSentenceSearch(deferredQuery, 6) : []),
    [mode, onOpenSentence, deferredQuery, runSentenceSearch],
  );
  // Which suggestion is highlighted for keyboard/mouse navigation (-1 = none → plain Enter AI-searches).
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const suggestionsListRef = useRef<HTMLDivElement>(null);
  const suggestionsId = useId();

  // Escape closes the search box (clearing what was typed) or the results popup, unless a layer above
  // it (a review popup, a dialog) is still open.
  useEscapeLayer(() => {
    if (mode === 'input') { setQuery(''); setHighlightedIndex(-1); }
    setMode('idle');
  }, 55, mode !== 'idle');
  // Keep the highlight in range as the list changes, and scroll the highlighted row into view.
  useEffect(() => { setHighlightedIndex(i => (i >= suggestions.length ? suggestions.length - 1 : i)); }, [suggestions.length]);
  useEffect(() => {
    if (highlightedIndex < 0) return;
    const el = suggestionsListRef.current?.children[highlightedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  // Open a matched sentence for review and FULLY dismiss the search (close + clear query + reset
  // highlight) — jumping to a card must never leave the search box/dropdown "locked" open behind it.
  const openSuggestion = useCallback((idx: number) => {
    const s = suggestions[idx];
    if (!s || !onOpenSentence) return;
    setMode('idle');
    setQuery('');
    setHighlightedIndex(-1);
    onOpenSentence(suggestions, idx);
  }, [suggestions, onOpenSentence]);

  const clearError = useCallback(() => setError(null), []);
  const {
    queue, readyItems, busyCount, scanning, updateQueue, enqueue, submitQuery, finalizeResult,
  } = useSearchQueue({
    findSavedByWord, onRefreshReplace, onCompareReady, openWhenReady: setPendingOpenId, showError, clearError, showStatus,
  });
  const readyCount = readyItems.length;
  const isBusy = busyCount > 0 || scanning; // scanning = sentence→expression scan before items are enqueued

  // Auto-open the popup once an instant DB hit becomes ready (AI results stay on the floating button)
  useEffect(() => {
    if (!pendingOpenId) return;
    const idx = readyItems.findIndex(q => q.id === pendingOpenId);
    if (idx < 0) return;
    setViewingQueueIdx(idx);
    setViewingVocabIdx(0);
    setMode('viewing');
    setPendingOpenId(null);
    const w = readyItems[idx]?.results?.vocabs?.[0]?.word;
    if (w) speakWord(w);
  }, [pendingOpenId, readyItems]);

  // Cmd+F / Ctrl+F keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (mode === 'input') {
          inputRef.current?.focus();
        } else {
          setMode('input');
        }
      }
      // Arrow key navigation in viewing mode — stop propagation so background carousel doesn't also move
      if (mode === 'viewing' && readyItems.length > 0) {
        if (isTypingTarget(e.target)) return;
        const currentResult = readyItems[viewingQueueIdx]?.results;
        const vocabCount = currentResult?.vocabs?.length || 0;

        // Cmd/Ctrl+1–4: read the displayed card's corresponding example sentence (natural voice).
        // A second press on the same sentence pauses/resumes — matches the DetailView shortcut.
        if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const vocab = currentResult?.vocabs?.[viewingVocabIdx];
          const sentence = stripSentenceMarkers((vocab?.examples || [])[Number(e.key) - 1] || '').trim();
          if (!sentence) return;
          const pb = getPlaybackState();
          if (pb.text === sentence) {
            if (pb.status === 'loading') return;                       // already starting this one
            if (pb.status === 'paused') { resumeCurrent(); return; }
            if (pb.status === 'playing' && getPlaybackProgress() < 0.85) { pauseCurrent(); return; } // mid-clip → pause
          }
          holdKeepAlive();
          speakNatural(sentence, { allowDownload: true });
          return;
        }

        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (vocabCount > 1) {
            const prev = viewingVocabIdx > 0 ? viewingVocabIdx - 1 : vocabCount - 1;
            setViewingVocabIdx(prev);
            if (currentResult?.vocabs?.[prev]?.word) speakWord(currentResult.vocabs[prev].word);
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (vocabCount > 1) {
            const next = (viewingVocabIdx + 1) % vocabCount;
            setViewingVocabIdx(next);
            if (currentResult?.vocabs?.[next]?.word) speakWord(currentResult.vocabs[next].word);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [mode, readyItems, viewingQueueIdx, viewingVocabIdx, holdKeepAlive]);

  // Auto-focus input
  useEffect(() => {
    if (mode === 'input') {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [mode]);

  // Submit from input box — add to queue and switch to viewing once ready. Offline, a saved word still
  // opens (the queue reuses saved cards without the network); anything else needs the AI.
  const handleSubmit = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    if (!isOnline && (looksLikeSentence(q) || findSavedByWord(q).length === 0)) {
      showError("You're offline, so only saved words can be looked up.");
      return;
    }
    void submitQuery(q);
    setQuery('');
    setMode('idle'); // Go back to idle — spinner shows on floating button
  }, [query, isOnline, submitQuery, findSavedByWord, showError]);

  // One timer for the save toast, so an earlier save's timer can't cut a newer message short.
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const saveToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSaveToast = useCallback((msg: string) => {
    setSaveToast(msg);
    if (saveToastTimer.current) clearTimeout(saveToastTimer.current);
    saveToastTimer.current = setTimeout(() => setSaveToast(null), 2000);
  }, []);
  useEffect(() => () => { if (saveToastTimer.current) clearTimeout(saveToastTimer.current); }, []);

  // Save a single vocab
  const saveOneVocab = useCallback((vocab: VocabCard) => {
    if (isVocabSaved(vocab)) return false; // already saved
    onSave(makeVocabStoredItem(vocab));
    return true;
  }, [onSave, isVocabSaved]);

  // Save ALL meanings of a specific queue item's results
  const handleSaveWord = useCallback((result: SearchResult | null) => {
    if (!result?.vocabs?.length) return;
    let count = 0;
    for (const vocab of result.vocabs) {
      if (saveOneVocab(vocab)) count++;
    }
    if (count > 0) {
      showSaveToast(`Saved "${result.query}" (${count} ${count === 1 ? 'meaning' : 'meanings'})`);
    } else {
      showSaveToast(`"${result.query}" already saved`);
    }
  }, [saveOneVocab, showSaveToast]);

  // Save ALL meanings of ALL ready queue items
  const handleSaveAll = useCallback(() => {
    let totalCount = 0;
    let wordCount = 0;
    for (const item of readyItems) {
      if (!item.results?.vocabs?.length) continue;
      let wordSaved = false;
      for (const vocab of item.results.vocabs) {
        if (saveOneVocab(vocab)) { totalCount++; wordSaved = true; }
      }
      if (wordSaved) wordCount++;
    }
    if (totalCount > 0) {
      showSaveToast(`Saved ${totalCount} meanings from ${wordCount} ${wordCount === 1 ? 'word' : 'words'}`);
    } else {
      showSaveToast('All items already saved');
    }
  }, [readyItems, saveOneVocab, showSaveToast]);

  // Keep single-vocab save for VocabCard's internal use
  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    if (saveOneVocab(vocab)) showSaveToast(`Saved "${vocab.word}"`);
  }, [saveOneVocab, showSaveToast]);

  // Save the raw typed sentence to the Sentences list (sentence mode). No analysis — we "just save the
  // sentence"; the already-saved expressions inside it are indexed/highlighted automatically wherever it's
  // shown (HighlightedSentence scans each word against the library). sourceWord is '' (no single source).
  const handleSaveSentenceClick = useCallback(() => {
    const q = query.trim();
    if (!q || !onSaveSentence) return;
    if (isSentenceSaved?.(q)) {
      showSaveToast('Sentence already saved');
    } else {
      onSaveSentence(q, '', undefined);
      showSaveToast('Sentence saved');
    }
    setQuery('');
  }, [query, onSaveSentence, isSentenceSaved, showSaveToast]);

  // Remove a single item from queue
  const dismissQueueItem = useCallback((id: string) => {
    updateQueue({ type: 'dismiss', id });
    // Adjust viewing index if needed
    setViewingQueueIdx(prev => {
      const newReady = queue.filter(q => q.id !== id && q.status === 'ready');
      if (newReady.length === 0) {
        setMode('idle');
        return 0;
      }
      return Math.min(prev, newReady.length - 1);
    });
    setViewingVocabIdx(0);
  }, [queue, updateQueue]);

  // Clear all completed items
  const clearQueue = useCallback(() => {
    updateQueue({ type: 'clear-finished' });
    setMode('idle');
    setViewingQueueIdx(0);
    setViewingVocabIdx(0);
  }, [updateQueue]);

  const handleFloatingClick = () => {
    // Always open input — lets user search more even when results are ready
    setMode('input');
  };

  const handleViewResults = () => {
    setViewingQueueIdx(0);
    setViewingVocabIdx(0);
    setMode('viewing');
    const firstReady = readyItems[0];
    if (firstReady?.results?.vocabs?.[0]?.word) {
      speakWord(firstReady.results.vocabs[0].word);
    }
  };

  const handleClose = () => {
    setMode('idle');
  };

  // Touch handlers for swipe navigation in results popup
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const diffX = e.changedTouches[0].clientX - touchStart.current.x;
    const diffY = e.changedTouches[0].clientY - touchStart.current.y;
    touchStart.current = null;

    if (Math.abs(diffX) <= Math.abs(diffY) * 1.5 || Math.abs(diffX) <= SWIPE_THRESHOLD) return;

    const currentResult = readyItems[viewingQueueIdx]?.results;
    const vocabCount = currentResult?.vocabs?.length || 0;

    if (vocabCount > 1) {
      if (diffX < 0) {
        const next = (viewingVocabIdx + 1) % vocabCount;
        setViewingVocabIdx(next);
        if (currentResult?.vocabs?.[next]?.word) speakWord(currentResult.vocabs[next].word);
      } else if (viewingVocabIdx > 0) {
        setViewingVocabIdx(viewingVocabIdx - 1);
        if (currentResult?.vocabs?.[viewingVocabIdx - 1]?.word) speakWord(currentResult.vocabs[viewingVocabIdx - 1].word);
      }
    }
  };

  // Current viewing state
  const viewingItem = mode === 'viewing' ? readyItems[viewingQueueIdx] : null;
  const viewingResult = viewingItem?.results;
  const viewingVocab = viewingResult?.vocabs?.[viewingVocabIdx];
  const viewingVocabCount = viewingResult?.vocabs?.length || 0;
  // The results popup is modal: focus moves into it, Tab stays inside, the page behind goes inert, and
  // closing it gives focus back.
  const resultsOpen = !!viewingItem && (!!viewingVocab || viewingItem.kind === 'compare');
  const resultsDialogRef = useRef<HTMLDivElement>(null);
  useOverlay(resultsOpen);
  useModalFocus(resultsDialogRef, resultsOpen);

  // Warm the TTS cache for the card's example SENTENCES (the word uses the system voice) so taps are instant.
  useEffect(() => {
    if (!viewingVocab) return;
    prefetchTTS((viewingVocab.examples || []).filter(Boolean) as string[]);
  }, [viewingVocab]);

  // Refresh button on the card: a REAL re-run of the AI for this word. We refresh the viewed item
  // IN PLACE — keep showing its current card (with a spinner) while the AI runs, then swap in the fresh
  // result — instead of clearing the queue entry (which blanked the popup until the API returned).
  const handleRefreshCard = useCallback((word: string) => {
    const trimmed = word.trim();
    const item = mode === 'viewing' ? readyItems[viewingQueueIdx] : null;
    if (!trimmed || !item || item.refreshing) return;
    const id = item.id;
    const analyzeMode = item.analyzeMode;
    updateQueue({ type: 'refresh-start', id }); // keep results visible
    // An expression taken from a sentence is refreshed as the same unit, not re-split into its words.
    analyzeInput(trimmed, analyzeMode ? { mode: analyzeMode } : undefined).then(result => {
      updateQueue({ type: 'refresh-ready', id, query: trimmed, results: result });
      setViewingVocabIdx(0);
      finalizeResult(id, trimmed, result);
    }).catch(err => {
      warn('🔍 Refresh failed "' + trimmed + '":', err?.message);
      updateQueue({ type: 'refresh-fail', id });
      if (isAuthenticationError(err)) rememberSearchRetry({ query: trimmed, analyzeMode });
      showError(describeSearchError(trimmed, err), isRetryableSearchError(err) ? trimmed : undefined, analyzeMode);
    });
  }, [mode, readyItems, viewingQueueIdx, finalizeResult, showError, updateQueue]);

  // Eyes-free zone read: a click/tap in the popup body's top quarter plays the 1st example sentence, the
  // second quarter the 2nd; the bottom half is inert. Zones are measured against the VISIBLE popup body
  // (the scroll container is e.currentTarget), NOT the full card — so they stay the same on-screen bands no
  // matter how far a tall card is scrolled, and you never have to chase the tiny speaker icon. Mirrors the
  // DetailView eyes-free zones and routes through the shared playback so a second tap on the same zone
  // pauses/resumes. One onClick path covers desktop clicks AND mobile taps (synthesized click); controls
  // inside the card stopPropagation, and the guard skips the rest.
  const handleCardZoneRead = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (window.getSelection()?.toString().trim()) return; // don't hijack a text selection
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, [role="button"], input, textarea, select, label')) return; // a control
    const examples = (viewingVocab?.examples || []).map(s => stripSentenceMarkers(s || '').trim()).filter(Boolean);
    if (!examples.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientY - rect.top;
    const zone = rel < rect.height / 4 ? 0 : rel < rect.height / 2 ? 1 : -1; // top ¼ → 1st, 2nd ¼ → 2nd
    if (zone < 0) return;
    flashZone(zone);
    const sentence = examples[Math.min(zone, examples.length - 1)];
    const pb = getPlaybackState();
    if (pb.text === sentence) {
      if (pb.status === 'loading') return;                                          // already starting this one
      if (pb.status === 'paused') { resumeCurrent(); return; }
      if (pb.status === 'playing' && getPlaybackProgress() < 0.85) { pauseCurrent(); return; } // mid-clip → pause
    }
    holdKeepAlive();
    speakNatural(sentence, { allowDownload: true });
  }, [viewingVocab, flashZone, holdKeepAlive]);

  // The error toast's retry: replays the query the failure carries.
  const retryFailedSearch = (failed: SearchErrorToast) => {
    const q = failed.query; const mode = failed.analyzeMode; setError(null);
    if (!q) return;
    // Preserve routing: a failed extracted expression re-analyzes as a unit (batch); a failed
    // user query (word or sentence) goes back through submitQuery (which re-scans if a sentence).
    if (mode) enqueue(q, { forceAI: true, analyzeMode: mode }); else void submitQuery(q);
  };

  return (
    <>
      <SearchToasts
        saveToast={saveToast}
        statusToast={statusToast}
        error={error}
        onRetry={retryFailedSearch}
        onDismissError={() => setError(null)}
      />

      {/* Input overlay */}
      {mode === 'input' && (
        <SearchInputBar
          inputRef={inputRef}
          query={query}
          setQuery={setQuery}
          suggestions={suggestions}
          highlightedIndex={highlightedIndex}
          setHighlightedIndex={setHighlightedIndex}
          suggestionsListRef={suggestionsListRef}
          suggestionsId={suggestionsId}
          onOpenSuggestion={openSuggestion}
          onSubmit={handleSubmit}
          canSaveSentence={!!(query.trim() && looksLikeSentence(query) && onSaveSentence)}
          onSaveSentence={handleSaveSentenceClick}
          readyCount={readyCount}
          onViewResults={handleViewResults}
          onClose={handleClose}
        />
      )}

      {/* Results popup */}
      {resultsOpen && viewingItem && (
        <SearchResultsSheet
          dialogRef={resultsDialogRef}
          viewingItem={viewingItem}
          viewingResult={viewingResult}
          viewingVocabIdx={viewingVocabIdx}
          viewingVocabCount={viewingVocabCount}
          readyItems={readyItems}
          viewingQueueIdx={viewingQueueIdx}
          setViewingQueueIdx={setViewingQueueIdx}
          setViewingVocabIdx={setViewingVocabIdx}
          isVocabSaved={isVocabSaved}
          onClose={handleClose}
          onSaveWord={handleSaveWord}
          onDismiss={dismissQueueItem}
          onSaveAll={handleSaveAll}
          onClearAll={clearQueue}
        >
          {viewingVocab && (
            <SearchVocabPane
              vocabs={viewingResult!.vocabs}
              viewingVocab={viewingVocab}
              viewingVocabIdx={viewingVocabIdx}
              viewingVocabCount={viewingVocabCount}
              setViewingVocabIdx={setViewingVocabIdx}
              onCardZoneRead={handleCardZoneRead}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
              zoneFlash={zoneFlash}
              isVocabSaved={isVocabSaved}
              onSaveVocab={handleSaveVocab}
              onSearch={onSearch}
              onRefresh={handleRefreshCard}
              onCompare={onCompare}
              onLazyLoadImage={onLazyLoadImage}
              onSaveSentence={onSaveSentence}
              isSentenceSaved={isSentenceSaved}
            />
          )}
        </SearchResultsSheet>
      )}

      {/* Floating button — hidden when input or viewing is open */}
      {mode !== 'input' && mode !== 'viewing' && (
        <SearchFab readyCount={readyCount} busyCount={busyCount} isBusy={isBusy} onClick={handleFloatingClick} />
      )}
    </>
  );
};
