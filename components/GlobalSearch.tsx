import React, { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue, useId } from 'react';
import { SearchResult, VocabCard, StoredItem, ComparisonResult } from '../types';
import { makeVocabStoredItem } from '../services/items';
import { speakWord, prefetchTTS } from '../services/neuralTts';
import { stripSentenceMarkers } from '../services/sentenceMarkers';
import { useSentenceSearch } from '../services/sentenceSearch';
import { useEscapeLayer } from './escapeStack';
import { isTypingTarget } from './keyboardTarget';
import { useModalFocus } from './Modal';
import { useOverlay } from './overlayStack';
import { useLatest } from '../hooks/useStableValue';
// The analysis route makes the same call, so a query the box treats as a word is analyzed as one.
import { looksLikeSentence } from '../services/queryMode';
import { useSearchQueue } from './search/useSearchQueue';
import { useSheetPlayback } from './search/useSheetPlayback';
import { useTimedMessage } from './search/useTimedMessage';
import { meaningAfterRefresh, stepMeaning, viewingIndexAfterDismiss, type SearchMode } from './search/searchViewing';
import { SearchToasts, type SearchErrorToast } from './search/SearchToasts';
import { SearchInputBar } from './search/SearchInputBar';
import { SearchResultsSheet } from './search/SearchResultsSheet';
import { SearchVocabPane } from './search/SearchVocabPane';
import { SearchFab } from './search/SearchFab';

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

/**
 * The search button and everything it opens: the search box, the results sheet and the search's notices. The
 * queue of lookups and comparisons lives in search/useSearchQueue; this component holds what's on screen (the
 * mode, the open result and meaning, the query) and the actions on it, and composes the pieces in search/.
 */
export const GlobalSearch: React.FC<Props> = ({ onSave, isVocabSaved, findSavedByWord, onSearch, isOnline, onLazyLoadImage, onRefreshReplace, onSaveSentence, isSentenceSaved, onCompareReady, onCompare, sentenceItems, onOpenSentence }) => {
  const [mode, setMode] = useState<SearchMode>('idle');
  const [query, setQuery] = useState('');
  // Viewing state: which queue item and which vocab within it
  const [viewingQueueIdx, setViewingQueueIdx] = useState(0);
  const [viewingVocabIdx, setViewingVocabIdx] = useState(0);
  // When a DB hit (already-saved word) becomes ready, auto-open its card. AI results don't set this.
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { zoneFlash, flashZone, playOrToggleSentence } = useSheetPlayback(mode);

  // Surface a failed search as an auto-dismissing toast. The floating search has no inline results
  // area, so without this a failed queue item just vanishes (the bug behind silent search failures).
  const { message: error, show: showErrorToast, clear: clearError } = useTimedMessage<SearchErrorToast>(6000);
  const showError = useCallback((msg: string, query?: string, analyzeMode?: 'batch') => {
    // Search failures remain actionable until retried. Informational failures can still expire.
    showErrorToast({ msg, query, analyzeMode }, { untilCleared: !!query });
  }, [showErrorToast]);

  // Neutral status pill (top-center) — "scanning…/found N expressions" notices that aren't errors.
  const { message: statusToast, show: showStatus } = useTimedMessage<string>(3500);
  // The save confirmation pill.
  const { message: saveToast, show: showSaveToast } = useTimedMessage<string>(2000);

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

  const {
    queue, readyItems, busyCount, scanning, updateQueue, enqueue, submitQuery, refreshInPlace,
  } = useSearchQueue({
    findSavedByWord, onRefreshReplace, onCompareReady, openWhenReady: setPendingOpenId, showError, clearError, showStatus,
  });
  const readyCount = readyItems.length;
  const isBusy = busyCount > 0 || scanning; // scanning = sentence→expression scan before items are enqueued

  // Current viewing state
  const viewingItem = mode === 'viewing' ? readyItems[viewingQueueIdx] : null;
  const viewingResult = viewingItem?.results;
  const viewingVocab = viewingResult?.vocabs?.[viewingVocabIdx];
  const viewingVocabCount = viewingResult?.vocabs?.length || 0;

  // Shows another meaning of the open result; with `speak` (the arrow keys and swipes), also says its word.
  const showMeaning = useCallback((index: number, options?: { speak?: boolean }) => {
    setViewingVocabIdx(index);
    const word = viewingResult?.vocabs?.[index]?.word;
    if (options?.speak && word) speakWord(word);
  }, [viewingResult]);
  // Opens another ready result, at its first meaning.
  const showResult = useCallback((index: number) => {
    setViewingQueueIdx(index);
    setViewingVocabIdx(0);
  }, []);

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

  // The arrow and Cmd+1–4 keys read the open result through this ref, so their listener is added once per mode
  // instead of again after every change to the queue.
  const sheetKeysRef = useLatest({ readyItems, viewingQueueIdx, viewingVocabIdx, playOrToggleSentence, showMeaning });

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
      const { readyItems, viewingQueueIdx, viewingVocabIdx, playOrToggleSentence, showMeaning } = sheetKeysRef.current;
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
          playOrToggleSentence(sentence);
          return;
        }

        // ←/→ step through the meanings, round from either end, and say the word.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopImmediatePropagation();
          const next = stepMeaning(viewingVocabIdx, vocabCount, e.key === 'ArrowLeft' ? -1 : 1, true);
          if (next !== null) showMeaning(next, { speak: true });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [mode, sheetKeysRef]);

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
      const next = viewingIndexAfterDismiss(queue, id, prev);
      if (next === null) {
        setMode('idle');
        return 0;
      }
      return next;
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

  // Refresh button on the card: a real re-run of the AI for this word, refreshing the open result in place (see
  // refreshInPlace). The fresh result shows its first meaning, unless the user has moved to another result by then.
  // It reads the open result through a ref, so the card's onRefresh stays the same while other results arrive.
  const viewingItemRef = useLatest(viewingItem);
  const handleRefreshCard = useCallback((word: string) => {
    const item = viewingItemRef.current;
    if (!item) return;
    refreshInPlace(item, word, () => {
      const openId = viewingItemRef.current?.id;
      setViewingVocabIdx(index => meaningAfterRefresh(openId, item.id, index));
    });
  }, [viewingItemRef, refreshInPlace]);

  // The error toast's retry: replays the query the failure carries.
  const retryFailedSearch = (failed: SearchErrorToast) => {
    const q = failed.query; const mode = failed.analyzeMode; clearError();
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
        onDismissError={clearError}
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
          meaningIndex={viewingVocabIdx}
          meaningCount={viewingVocabCount}
          readyItems={readyItems}
          resultIndex={viewingQueueIdx}
          onShowResult={showResult}
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
              meaningIndex={viewingVocabIdx}
              onShowMeaning={showMeaning}
              zoneFlash={zoneFlash}
              flashZone={flashZone}
              playOrToggleSentence={playOrToggleSentence}
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
