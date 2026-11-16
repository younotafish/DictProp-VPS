import React, { useState, useRef, useEffect, useCallback, useDeferredValue, useId } from 'react';
import { createPortal } from 'react-dom';
import { SearchResult, VocabCard, StoredItem, ComparisonResult } from '../types';
import { makeVocabStoredItem } from '../services/items';
import { prefetchTTS } from '../services/neuralTts';
import { stripSentenceMarkers } from '../services/sentenceMarkers';
import { useSentenceSearch } from '../hooks/useSentenceSearch';
import { hasEscapeLayerAbove, useEscapeLayer } from './escapeStack';
import { useNoticeSlot } from './noticeSlots';
import { isKeyboardFocusedControl, isTypingTarget } from './keyboardTarget';
import { useModalFocus } from './Modal';
import { useOverlay } from './overlayStack';
import { useLatest } from '../hooks/useStableValue';
// The analysis route makes the same call, so a query the box treats as a word is analyzed as one.
import { looksLikeSentence } from '../server/src/shared/query-mode';
import { useSearchQueue } from './search/useSearchQueue';
import { useSheetPlayback } from './search/useSheetPlayback';
import { useTimedMessage } from '../hooks/useTimedMessage';
import {
  clampMeaning, meaningAfterRefresh, neighbourAfterDismiss, resolveViewing, type SearchMode,
} from './search/searchViewing';
import { searchSheetKeys, type SheetAction } from './search/searchSheetKeys';
import { finishedEntries, nextFailureExpiry, openIndexForResults, summarizeFailures } from './search/searchQueue';
import { SearchToasts, type SearchErrorToast } from './search/SearchToasts';
import { SearchInputBar } from './search/SearchInputBar';
import { SearchResultsSheet } from './search/SearchResultsSheet';
import { SearchVocabPane } from './search/SearchVocabPane';
import { SearchFab } from './search/SearchFab';
import { SearchStatusPill } from './search/SearchStatusPill';
import { deriveSearchStatus, nextStatusChangeAt } from './search/searchStatusLine';

/** No saved sentences: one array for every render, so the suggestions' index isn't rebuilt each time. */
const NO_SENTENCES: StoredItem[] = [];

const earliest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

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
   * sentence view, above the lesson row.
   */
  aboveTabBar: boolean;
  /** A decision dialog is open (App's useOverlays().modalOpen), so the status line stays out of its way. */
  statusHidden: boolean;
  /** Offers `undo` on the app's undo pill, labelled `message`: Clear all offers to put the results back. */
  onOfferUndo: (message: string, undo: () => void) => void;
}

/**
 * The search button and everything it opens: the search box, the results sheet and the search's notices. The
 * queue of lookups and comparisons lives in search/useSearchQueue; this component holds what's on screen (the
 * mode, the open result and meaning, the query) and the actions on it, and composes the pieces in search/.
 */
export const GlobalSearch: React.FC<Props> = ({ onSave, isVocabSaved, findSavedByWord, onSearch, isOnline, onLazyLoadImage, onRefreshReplace, onSaveSentence, isSentenceSaved, onCompareReady, onCompare, sentenceItems, onOpenSentence, aboveTabBar, statusHidden, onOfferUndo }) => {
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
  const {
    zoneFlash, flashZone, playOrToggleSentence, speakSheetWord, readExamples, togglePlayback, stopSheetAudio,
  } = useSheetPlayback(mode);

  // The error toast shows a passing notice (a request refused offline, a refresh that failed) for 6 s, hiding the
  // failures the queue keeps until it goes, or else those failures (see summarizeFailures). The floating search has no
  // inline results area, so without it a failed lookup would just vanish.
  const { message: notice, show: showNotice, clear: clearNotice } = useTimedMessage<string>(6000);

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
    queue, readyItems, unseenCount, runningCount, isBusy, updateQueue, lookUp, refreshInPlace,
  } = useSearchQueue({
    findSavedByWord, isOnline, onRefreshReplace, onCompareReady, onCompare, openWhenReady: setPendingOpenId, showNotice,
  });
  const readyCount = readyItems.length;

  // The time the status line and the error toast are worked out at. It moves on when one of them is due to change (a
  // line or a failure running out), so that change re-renders without a ticking clock; something that happens later
  // than it still shows, since it can only run out after it began.
  const [clock, setClock] = useState(() => Date.now());
  const status = deriveSearchStatus(queue, clock);
  const failures = summarizeFailures(queue, clock);
  const nextChange = earliest(nextStatusChangeAt(queue, clock), nextFailureExpiry(queue, clock));
  useEffect(() => {
    if (nextChange === null) return;
    const timer = setTimeout(() => setClock(Math.max(Date.now(), nextChange)), Math.max(0, nextChange - Date.now()));
    return () => clearTimeout(timer);
  }, [nextChange]);
  // The status line shows only beside the floating button (not while the box or the sheet is open) and stays out of a
  // decision dialog's way; its slot is the notice stack's, so it follows the stack's place above the tab bar or a card.
  const statusSlot = useNoticeSlot('search');
  const statusShown = mode === 'idle' && !statusHidden && statusSlot !== null && status !== null;
  const errorToast: SearchErrorToast | null = notice !== null ? { msg: notice }
    : failures && { msg: failures.newest.failure.message, more: failures.others, action: failures.action ?? undefined };

  // Current viewing state: the open result stays the same one while other lookups finish around it.
  const viewing = mode === 'viewing' ? resolveViewing(readyItems, viewingId) : null;
  const viewingItem = viewing?.item ?? null;
  const viewingResult = viewingItem?.results;
  const viewingVocabCount = viewingResult?.vocabs?.length || 0;
  const meaningIndex = clampMeaning(viewingVocabIdx, viewingVocabCount);
  const viewingVocab = viewingResult?.vocabs?.[meaningIndex];

  // Shows another meaning of the open result and says its word, however it was asked for: the arrows, a swipe, the
  // chevrons or a dot. The sheet's own audio stops first.
  const showMeaning = useCallback((index: number) => {
    stopSheetAudio();
    setViewingVocabIdx(index);
    const word = viewingResult?.vocabs?.[index]?.word;
    if (word) speakSheetWord(word);
  }, [viewingResult, stopSheetAudio, speakSheetWord]);
  // Opens another ready result (the sheet passes its position) at its first meaning, and says its word.
  const showResult = useCallback((index: number) => {
    const item = readyItems[index];
    if (!item) return;
    stopSheetAudio();
    setViewingId(item.id);
    setViewingVocabIdx(0);
    const word = item.results?.vocabs?.[0]?.word;
    if (word) speakSheetWord(word);
  }, [readyItems, stopSheetAudio, speakSheetWord]);

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
    if (w) speakSheetWord(w);
  }, [pendingOpenId, readyItems, speakSheetWord]);

  // The open result can leave the ready ones while the sheet is up: a refresh of the same word from its card replaces
  // the entry, and the fresh result opens by itself once it's ready. Until then the sheet closes, rather than show
  // another result or nothing.
  const openResultGone = mode === 'viewing' && !viewingItem;
  useEffect(() => { if (openResultGone) setMode('idle'); }, [openResultGone]);

  // A result counts as seen once the sheet shows it, whether the user opened it or it opened by itself; the search
  // button and the results pill count only the others.
  const openUnseenId = viewingItem && !viewingItem.seen ? viewingItem.id : null;
  useEffect(() => { if (openUnseenId) updateQueue({ type: 'mark-seen', id: openUnseenId }); }, [openUnseenId, updateQueue]);

  // Auto-focus input, selecting the text when Edit put a failed query there.
  const selectOnOpenRef = useRef(false);
  const focusBox = useCallback((select: boolean) => {
    setTimeout(() => {
      inputRef.current?.focus();
      if (select) inputRef.current?.select();
    }, 50);
  }, []);
  useEffect(() => {
    if (mode !== 'input') return;
    focusBox(selectOnOpenRef.current);
    selectOnOpenRef.current = false;
  }, [mode, focusBox]);

  // Submit from input box: look the typed text up (see useSearchQueue's lookUp) and go back to the button, whose spinner
  // shows the lookup running. Offline, a word asked for before or a saved word still answers; anything that needs the
  // AI says so in the error toast, and the box keeps the text.
  const handleSubmit = useCallback(() => {
    const q = query.trim();
    if (!q || !lookUp({ query: q, source: 'text' })) return;
    setQuery('');
    setMode('idle');
  }, [query, lookUp]);

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
  // S saves the meaning on screen, and says so when it was saved already: S never unsaves.
  const saveOpenMeaning = useCallback((vocab: VocabCard) => {
    if (isVocabSaved(vocab)) showSaveToast(`"${vocab.word}" already saved`);
    else handleSaveVocab(vocab);
  }, [isVocabSaved, showSaveToast, handleSaveVocab]);

  // Save the raw typed sentence to the Sentences list (sentence mode). No analysis — we "just save the
  // sentence"; the already-saved expressions inside it are indexed/highlighted automatically wherever it's
  // shown (HighlightedSentence scans each word against the library). sourceWord is '' (no single source). The text
  // stays in the box, its bookmark now a "Sentence saved" check, so Send can still analyze it.
  const sentenceTyped = !!(query.trim() && looksLikeSentence(query) && onSaveSentence);
  const sentenceSaved = sentenceTyped && !!isSentenceSaved?.(query.trim());
  const handleSaveSentenceClick = useCallback(() => {
    const q = query.trim();
    if (!q || !onSaveSentence) return;
    if (isSentenceSaved?.(q)) {
      showSaveToast('Sentence already saved');
    } else {
      onSaveSentence(q, '', undefined);
      showSaveToast('Sentence saved');
    }
  }, [query, onSaveSentence, isSentenceSaved, showSaveToast]);

  // The sheet's Dismiss drops the open result and shows the next ready one, or the previous one after the last,
  // saying its word as any switch of result does; dismissing the only one closes the sheet.
  const dismissQueueItem = useCallback((id: string) => {
    const next = neighbourAfterDismiss(readyItems, id);
    updateQueue({ type: 'dismiss', id });
    stopSheetAudio();
    setViewingId(next);
    setViewingVocabIdx(0);
    if (next === null) { setMode('idle'); return; }
    const word = readyItems.find(item => item.id === next)?.results?.vocabs?.[0]?.word;
    if (word) speakSheetWord(word);
  }, [readyItems, updateQueue, stopSheetAudio, speakSheetWord]);

  // Clear all drops every finished entry and closes the sheet; the undo pill then offers to put the results back,
  // failures included, without opening the sheet again.
  const clearQueue = useCallback(() => {
    const removed = finishedEntries(queue);
    updateQueue({ type: 'clear-finished' });
    setMode('idle');
    setViewingId(null);
    setViewingVocabIdx(0);
    const results = removed.filter(item => item.kind !== 'scan' && item.status === 'ready').length;
    if (results > 0) {
      onOfferUndo(`Cleared ${results} ${results === 1 ? 'result' : 'results'}`, () => updateQueue({ type: 'restore', entries: removed }));
    }
  }, [queue, updateQueue, onOfferUndo]);

  const handleFloatingClick = () => {
    // Always open input — lets user search more even when results are ready
    setMode('input');
  };

  // The results pill (or Enter in an empty box) opens the first result not seen yet, or the newest, and says its word.
  const handleViewResults = () => {
    const opening = readyItems[openIndexForResults(readyItems)];
    if (!opening) return;
    setViewingId(opening.id);
    setViewingVocabIdx(0);
    setMode('viewing');
    if (opening.results?.vocabs?.[0]?.word) {
      speakSheetWord(opening.results.vocabs[0].word);
    }
  };

  // X closes the box, keeping what was typed, unless it's a sentence just saved: that one has been dealt with.
  // (Escape always clears it.)
  const handleClose = () => {
    if (mode === 'input' && sentenceSaved) setQuery('');
    setMode('idle');
  };

  // The results popup is modal: focus moves into it, Tab stays inside, the page behind goes inert, and
  // closing it gives focus back. A lookup that came back without a card still opens, and says so.
  const resultsOpen = viewingItem !== null;
  const resultsDialogRef = useRef<HTMLDivElement>(null);
  useOverlay(resultsOpen);
  // A dialog that opens above the sheet (the review popup, a confirmation) takes the focus and the Tab key.
  useModalFocus(resultsDialogRef, resultsOpen, () => hasEscapeLayerAbove(55));

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

  // What a key does in the results sheet (see searchSheetKeys), on the open result and meaning.
  const examplesOf = (vocab: VocabCard | undefined): string[] =>
    (vocab?.examples || []).map(example => stripSentenceMarkers(example || '').trim()).filter(Boolean);
  const applySheetAction = (action: SheetAction) => {
    const examples = examplesOf(viewingVocab);
    switch (action.type) {
      case 'meaning': showMeaning(action.index); return;
      case 'result': showResult(action.index); return;
      case 'swallow': return;
      case 'readExample': if (examples[action.index]) playOrToggleSentence(examples[action.index]); return;
      case 'save': if (viewingVocab) saveOpenMeaning(viewingVocab); return;
      case 'saveAll': handleSaveWord(viewingResult ?? null); return;
      case 'pronounce': if (viewingVocab?.word) speakSheetWord(viewingVocab.word); return;
      case 'readExamples': readExamples(examples.slice(0, 2)); return;
      case 'togglePlayback': togglePlayback(examples[0]);
    }
  };
  // The keys read the open result through this ref, so their listener is added once per mode instead of again after
  // every change to the queue.
  const sheetKeysRef = useLatest({
    viewing, meaningIndex, meaningCount: viewingVocabCount, hasCard: !!viewingVocab, resultCount: readyItems.length, applySheetAction,
  });

  // Cmd+F / Ctrl+F opens the search box, or focuses it; in the results sheet, its keys. A dialog above the sheet (the
  // review popup, a confirmation) has the keys instead: the search leaves them all to it, only keeping Cmd+F from the
  // browser's find. A key the sheet acts on stops there, so nothing behind the sheet acts on it too.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const dialogAbove = hasEscapeLayerAbove(55);
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        if (dialogAbove) return;
        e.stopImmediatePropagation();
        if (mode === 'input') {
          inputRef.current?.focus();
        } else {
          setMode('input');
        }
        return;
      }
      const sheet = sheetKeysRef.current;
      if (mode !== 'viewing' || !sheet.viewing) return;
      const action = searchSheetKeys(e, {
        typing: isTypingTarget(e.target),
        dialogAbove,
        onControl: isKeyboardFocusedControl(e.target),
        resultCount: sheet.resultCount,
        resultIndex: sheet.viewing.index,
        meaningCount: sheet.meaningCount,
        meaningIndex: sheet.meaningIndex,
        hasCard: sheet.hasCard,
      });
      if (!action) return;
      if (action.type !== 'swallow') e.preventDefault();
      e.stopImmediatePropagation();
      sheet.applySheetAction(action);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [mode, sheetKeysRef]);

  // The error toast's buttons. Retry runs every failure that retrying could fix again, each in its own mode, where it
  // was; Edit puts a query the model found no entry for back in the box, selected, to fix the spelling; × clears what
  // the toast shows: a notice, after which the failures it hid show again, or else every failure.
  const retryFailures = () => updateQueue({ type: 'retry-failed' });
  const editFailedQuery = () => {
    if (failures?.action !== 'edit') return;
    updateQueue({ type: 'dismiss', id: failures.newest.id });
    setQuery(failures.newest.query);
    setHighlightedIndex(-1);
    if (mode === 'input') {
      focusBox(true);
    } else {
      selectOnOpenRef.current = true;
      setMode('input');
    }
  };
  const dismissErrorToast = () => {
    if (notice !== null) clearNotice();
    else updateQueue({ type: 'dismiss-failed' });
  };

  return (
    <>
      <SearchToasts
        saveToast={saveToast}
        error={errorToast}
        onRetry={retryFailures}
        onEdit={editFailedQuery}
        onDismissError={dismissErrorToast}
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
          canSaveSentence={sentenceTyped}
          sentenceSaved={sentenceSaved}
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
              context={viewing.item.context}
            />
          )}
        </SearchResultsSheet>
      )}

      {/* The status line, in the notice stack: only beside the floating button, and never over a decision dialog. */}
      {statusShown && status && statusSlot && createPortal(<SearchStatusPill status={status} onView={setPendingOpenId} />, statusSlot)}

      {/* Floating button — hidden when input or viewing is open */}
      {mode !== 'input' && mode !== 'viewing' && (
        <SearchFab
          unseenCount={unseenCount}
          readyCount={readyCount}
          runningCount={runningCount}
          isBusy={isBusy}
          aboveTabBar={aboveTabBar}
          quiet={statusShown && status?.kind === 'ready'}
          onClick={handleFloatingClick}
        />
      )}
    </>
  );
};
