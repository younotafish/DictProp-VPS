import React, { useState, useRef, useEffect, useCallback, useDeferredValue, useId } from 'react';
import { SearchResult, VocabCard, StoredItem, ComparisonResult } from '../types';
import { makeVocabStoredItem } from '../services/items';
import { speakWord, prefetchTTS } from '../services/neuralTts';
import { stripSentenceMarkers } from '../services/sentenceMarkers';
import { useSentenceSearch } from '../hooks/useSentenceSearch';
import { useEscapeLayer } from './escapeStack';
import { isTypingTarget } from './keyboardTarget';
import { useModalFocus } from './Modal';
import { useOverlay } from './overlayStack';
import { useLatest } from '../hooks/useStableValue';
// The analysis route makes the same call, so a query the box treats as a word is analyzed as one.
import { looksLikeSentence } from '../services/queryMode';
import { useSearchQueue } from './search/useSearchQueue';
import { useSheetPlayback } from './search/useSheetPlayback';
import { useTimedMessage } from '../hooks/useTimedMessage';
import {
  clampMeaning, meaningAfterRefresh, neighbourAfterDismiss, resolveViewing, stepMeaning, type SearchMode,
} from './search/searchViewing';
import { classifyEnqueue, openIndexForResults } from './search/searchQueue';
import { SearchToasts, type SearchErrorToast } from './search/SearchToasts';
import { SearchInputBar } from './search/SearchInputBar';
import { SearchResultsSheet } from './search/SearchResultsSheet';
import { SearchVocabPane } from './search/SearchVocabPane';
import { SearchFab } from './search/SearchFab';

/** No saved sentences: one array for every render, so the suggestions' index isn't rebuilt each time. */
const NO_SENTENCES: StoredItem[] = [];

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
  /**
   * Where the search button and its error toast float: true on a tab, above the tab bar; false over a card or
   * sentence view, above the lesson row. Left out, they keep their old offsets (bottom-24 and bottom-44).
   */
  aboveTabBar?: boolean;
}

/**
 * The search button and everything it opens: the search box, the results sheet and the search's notices. The
 * queue of lookups and comparisons lives in search/useSearchQueue; this component holds what's on screen (the
 * mode, the open result and meaning, the query) and the actions on it, and composes the pieces in search/.
 */
export const GlobalSearch: React.FC<Props> = ({ onSave, isVocabSaved, findSavedByWord, onSearch, isOnline, onLazyLoadImage, onRefreshReplace, onSaveSentence, isSentenceSaved, onCompareReady, onCompare, sentenceItems, onOpenSentence, aboveTabBar }) => {
  const [mode, setMode] = useState<SearchMode>('idle');
  const [query, setQuery] = useState('');
  // The open result, by its queue entry's id (its position among the ready results moves as earlier lookups finish),
  // and the meaning shown within it.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewingVocabIdx, setViewingVocabIdx] = useState(0);
  // The entry to open in the sheet once it's ready: a saved word, a refresh, a saved comparison, or a word asked for
  // again whose result is ready. Other AI results wait on the floating button.
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
  // Enter with nothing highlighted still runs the real AI search. Purely local (works offline). The exact matches
  // follow every keystroke; the typo-tolerant ones come once typing pauses, and the list stays empty until they do.
  const deferredQuery = useDeferredValue(query);
  const { results: suggestions } = useSentenceSearch(
    sentenceItems ?? NO_SENTENCES, mode === 'input' && onOpenSentence ? deferredQuery : '', 6,
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
    queue, readyItems, unseenCount, runningCount, isBusy, updateQueue, enqueue, submitQuery, refreshInPlace,
  } = useSearchQueue({
    findSavedByWord, onRefreshReplace, onCompareReady, openWhenReady: setPendingOpenId, showError, clearError, showStatus,
  });
  const readyCount = readyItems.length;

  // Current viewing state: the open result stays the same one while other lookups finish around it.
  const viewing = mode === 'viewing' ? resolveViewing(readyItems, viewingId) : null;
  const viewingItem = viewing?.item ?? null;
  const viewingResult = viewingItem?.results;
  const viewingVocabCount = viewingResult?.vocabs?.length || 0;
  const meaningIndex = clampMeaning(viewingVocabIdx, viewingVocabCount);
  const viewingVocab = viewingResult?.vocabs?.[meaningIndex];

  // Shows another meaning of the open result; with `speak` (the arrow keys and swipes), also says its word.
  const showMeaning = useCallback((index: number, options?: { speak?: boolean }) => {
    setViewingVocabIdx(index);
    const word = viewingResult?.vocabs?.[index]?.word;
    if (options?.speak && word) speakWord(word);
  }, [viewingResult]);
  // Opens another ready result (the sheet passes its position), at its first meaning.
  const showResult = useCallback((index: number) => {
    const id = readyItems[index]?.id;
    if (!id) return;
    setViewingId(id);
    setViewingVocabIdx(0);
  }, [readyItems]);

  // Open the sheet on the pendingOpenId entry once it's ready, at its first meaning, and say its word.
  useEffect(() => {
    if (!pendingOpenId) return;
    const item = readyItems.find(q => q.id === pendingOpenId);
    if (!item) return;
    setViewingId(item.id);
    setViewingVocabIdx(0);
    setMode('viewing');
    setPendingOpenId(null);
    const w = item.results?.vocabs?.[0]?.word;
    if (w) speakWord(w);
  }, [pendingOpenId, readyItems]);

  // The open result can leave the ready ones while the sheet is up: a refresh of the same word from its card replaces
  // the entry, and the fresh result opens by itself once it's ready. Until then the sheet closes, rather than show
  // another result or nothing.
  const openResultGone = mode === 'viewing' && !viewingItem;
  useEffect(() => { if (openResultGone) setMode('idle'); }, [openResultGone]);

  // A result counts as seen once the sheet shows it, whether the user opened it or it opened by itself; the search
  // button and the results pill count only the others.
  const openUnseenId = viewingItem && !viewingItem.seen ? viewingItem.id : null;
  useEffect(() => { if (openUnseenId) updateQueue({ type: 'mark-seen', id: openUnseenId }); }, [openUnseenId, updateQueue]);

  // The arrow and Cmd+1–4 keys read the open result through this ref, so their listener is added once per mode
  // instead of again after every change to the queue.
  const sheetKeysRef = useLatest({ viewingItem, meaningIndex, playOrToggleSentence, showMeaning });

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
      const { viewingItem, meaningIndex, playOrToggleSentence, showMeaning } = sheetKeysRef.current;
      if (mode === 'viewing' && viewingItem) {
        if (isTypingTarget(e.target)) return;
        const currentResult = viewingItem.results;
        const vocabCount = currentResult?.vocabs?.length || 0;

        // Cmd/Ctrl+1–4: read the displayed card's corresponding example sentence (natural voice).
        // A second press on the same sentence pauses/resumes — matches the DetailView shortcut.
        if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const vocab = currentResult?.vocabs?.[meaningIndex];
          const sentence = stripSentenceMarkers((vocab?.examples || [])[Number(e.key) - 1] || '').trim();
          if (!sentence) return;
          playOrToggleSentence(sentence);
          return;
        }

        // ←/→ step through the meanings, round from either end, and say the word.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopImmediatePropagation();
          const next = stepMeaning(meaningIndex, vocabCount, e.key === 'ArrowLeft' ? -1 : 1, true);
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

  // Submit from input box — add to queue and switch to viewing once ready. Offline, a word asked for before still
  // answers (its result opens, or it says it's still running), and so does a saved word (the queue reuses saved
  // cards without the network); anything else needs the AI.
  const handleSubmit = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    if (!isOnline && (looksLikeSentence(q) || (classifyEnqueue(queue, q) === 'new' && findSavedByWord(q).length === 0))) {
      showError("You're offline, so only saved words can be looked up.");
      return;
    }
    submitQuery(q);
    setQuery('');
    setMode('idle'); // Go back to idle — spinner shows on floating button
  }, [query, queue, isOnline, submitQuery, findSavedByWord, showError]);

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

  // The sheet's Dismiss drops the open result and shows the next ready one, or the previous one after the last;
  // dismissing the only one closes the sheet.
  const dismissQueueItem = useCallback((id: string) => {
    const next = neighbourAfterDismiss(readyItems, id);
    updateQueue({ type: 'dismiss', id });
    setViewingId(next);
    setViewingVocabIdx(0);
    if (next === null) setMode('idle');
  }, [readyItems, updateQueue]);

  // Clear all completed items
  const clearQueue = useCallback(() => {
    updateQueue({ type: 'clear-finished' });
    setMode('idle');
    setViewingId(null);
    setViewingVocabIdx(0);
  }, [updateQueue]);

  const handleFloatingClick = () => {
    // Always open input — lets user search more even when results are ready
    setMode('input');
  };

  // The results pill opens the first result not seen yet, or the newest, and says its word.
  const handleViewResults = () => {
    const opening = readyItems[openIndexForResults(readyItems)];
    if (!opening) return;
    setViewingId(opening.id);
    setViewingVocabIdx(0);
    setMode('viewing');
    if (opening.results?.vocabs?.[0]?.word) {
      speakWord(opening.results.vocabs[0].word);
    }
  };

  const handleClose = () => {
    setMode('idle');
  };

  // The results popup is modal: focus moves into it, Tab stays inside, the page behind goes inert, and
  // closing it gives focus back. A lookup that came back without a card still opens, and says so.
  const resultsOpen = viewingItem !== null;
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
    if (mode) enqueue(q, { forceAI: true, analyzeMode: mode }); else submitQuery(q);
  };

  return (
    <>
      <SearchToasts
        saveToast={saveToast}
        statusToast={statusToast}
        error={error}
        onRetry={retryFailedSearch}
        onDismissError={clearError}
        aboveTabBar={aboveTabBar}
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
          unseenCount={unseenCount}
          onViewResults={handleViewResults}
          onClose={handleClose}
        />
      )}

      {/* Results popup */}
      {viewing && (
        <SearchResultsSheet
          dialogRef={resultsDialogRef}
          viewingItem={viewing.item}
          meaningIndex={meaningIndex}
          meaningCount={viewingVocabCount}
          readyItems={readyItems}
          resultIndex={viewing.index}
          runningCount={runningCount}
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
              meaningIndex={meaningIndex}
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
        <SearchFab
          unseenCount={unseenCount}
          readyCount={readyCount}
          runningCount={runningCount}
          isBusy={isBusy}
          aboveTabBar={aboveTabBar}
          onClick={handleFloatingClick}
        />
      )}
    </>
  );
};
