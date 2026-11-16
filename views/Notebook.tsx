import React, { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef, startTransition } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { getItemTitle, type ItemGroup, type StoredItem, type SyncStatus, type VocabCard } from '../types';
import type { AuthUser } from '../services/auth';
import { TextAnalyzer } from '../components/TextAnalyzer';
import { BatchImport } from '../components/BatchImport';
import { JSONImport } from '../components/JSONImport';
import { makeVocabStoredItem } from '../services/items';
import { useLatest } from '../hooks/useStableValue';
import type { BatchImportProgress } from '../hooks/useBatchImport';
import {
  buildNotebookRows, listNoteFor, nextNotebookFilter, nextNotebookSort, notebookStats,
  type NotebookFilter, type NotebookRow, type NotebookSection, type NotebookSort,
} from '../services/notebookList';
import { readNotebookListView, writeNotebookListView } from '../services/notebook/listView';
import { aiCardStillValid, retryOffered, shouldBlurOnDrag } from '../services/notebook/searchBox';
import { firstVisibleRowIndex, nextScrollAction, type ListScrollInputs } from '../services/notebook/listScroll';
import { PLATFORM } from '../services/platform';
import { isImeKey, isTypingTarget } from '../components/keyboardTarget';
import { NotebookGroup } from './notebook/NotebookGroup';
import { SearchResultsCarousel } from './notebook/SearchResultsCarousel';
import { NotebookHeader } from './notebook/NotebookHeader';
import { NotebookToolsMenu } from './notebook/NotebookToolsMenu';
import { NotebookSearchBar } from './notebook/NotebookSearchBar';
import { ArchivedMatchesHeader, ArchivedToggle, DueHeader, ListNote } from './notebook/ListRows';
import { CompareBanner, CompareRow, CompareSelectedButton } from './notebook/CompareMode';
import { EmptyNotebook } from './notebook/EmptyNotebook';
import { BatchImportBanner } from './notebook/BatchImportBanner';
import { SearchErrorBanner } from './notebook/SearchErrorBanner';
import { useAutoHidingHeader } from './notebook/useAutoHidingHeader';
import { useNotebookAISearch } from './notebook/useNotebookAISearch';
import { useVoiceSearch } from './notebook/useVoiceSearch';
import { useNotebookSearch } from './notebook/useNotebookSearch';
import { useHorizontalSwipe } from './notebook/useHorizontalSwipe';
import { ActionStackContext, createActionStackStore } from './notebook/actionStack';

const virtualRowKey = (_index: number, row: NotebookRow) => row.key;

/** Where the browse list was when a search began: its first visible row and the scroll position. */
interface BrowseSpot { key: string | undefined; scrollTop: number }

interface NotebookProps {
  items: StoredItem[];
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: (groups: ItemGroup[], groupIndex: number, itemIndex: number) => void;
  user: AuthUser;
  /** Resolves false when the server couldn't be reached and the session was kept. */
  onSignOut: () => Promise<boolean>;
  /** Opens the list of reviews the server refused. */
  onViewRefusedReviews: () => void;
  syncStatus: SyncStatus;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  onForceSync: () => void;
  isOnline: boolean;
  /** The saved base words a query inflects (ran -> run), which a search lists first after the word typed. */
  matchSavedBases?: (query: string) => Set<string>;
  /** Tells the nav bar that the notebook moved its list itself, so the jump doesn't hide the bar. */
  onSyncScroll?: (element: Element) => void;
  isVocabSaved: (vocab: VocabCard) => boolean;
  onFindDuplicates: () => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onSave: (item: StoredItem) => void;
  onCompare: (words: string[]) => void;
  onSaveSentence: (text: string, word: string, sense?: string) => void;
  isSentenceSaved: (text: string) => boolean;
  /** A card or dialog is open over the notebook, whose keys are its own. */
  hasOverlay: boolean;
  onBatchImport: (words: string[]) => void;
  batchImportProgress: BatchImportProgress | null;
  onJSONImported: () => void;
  onGenerateAllSpeech: () => void;
  ttsGenProgress: { current: number; total: number; isRunning: boolean } | null;
  onRestoreImagesToServer: () => void;
  imageRestoreRunning: boolean;
  onDownloadOfflineImages: () => void;
  /** Opens the gestures and shortcuts sheet, from the tools menu. */
  onShowShortcuts?: () => void;
}

export const NotebookView: React.FC<NotebookProps> = ({
    items, onDelete, onSearch, onViewDetail,
    user, onSignOut, onViewRefusedReviews, syncStatus, onScroll, onForceSync, isOnline,
    isVocabSaved, onFindDuplicates, onArchive, onUnarchive, onSave, onCompare,
    onSaveSentence, isSentenceSaved, hasOverlay,
    onBatchImport, batchImportProgress, onJSONImported,
    onGenerateAllSpeech, ttsGenProgress,
    onRestoreImagesToServer, imageRestoreRunning, onDownloadOfflineImages, matchSavedBases, onSyncScroll, onShowShortcuts,
}) => {
  // The sort and filter last chosen on this device (review priority and words only at first), kept across relaunches.
  const [initialView] = useState(readNotebookListView);
  const [sortMode, setSortMode] = useState<NotebookSort>(initialView.sort);
  const [filterMode, setFilterMode] = useState<NotebookFilter>(initialView.filter);
  useEffect(() => { writeNotebookListView({ sort: sortMode, filter: filterMode }); }, [sortMode, filterMode]);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // Moves the list's clock on (see useNotebookSearch) when a card opens over the list.
  const [clockBump, setClockBump] = useState(0);
  const { headerRef, handleScroll, showHeader, syncScrollPosition } = useAutoHidingHeader(onScroll);
  // Which card's actions (Refresh, Archive, Delete) are open: one at most, and a scroll of the list closes them.
  const [actionStack] = useState(createActionStackStore);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    actionStack.close();
    handleScroll(e);
  }, [actionStack, handleScroll]);

  // AI Search state
  const {
    isSearching, searchResults, searchError, setSearchError, performAISearch, clearAISearch, submittedQueryRef,
  } = useNotebookAISearch(isOnline);
  // The search box, which a drag of the list or a lookup from a phone's keyboard blurs to drop the keyboard.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchFocused, setSearchFocused] = useState(false);

  // Every change to the query goes through here. Editing it, by any path, drops an AI card, its error and a lookup
  // still on its way that belong to the query before (case and spacing aside), and emptying it drops them all, so
  // none of them shows up under a query it doesn't answer.
  const changeQuery = useCallback((query: string) => {
    setLocalSearchQuery(query);
    if (!query.trim() || !aiCardStillValid(submittedQueryRef.current, query)) clearAISearch();
  }, [clearAISearch, submittedQueryRef]);

  // Every AI lookup starts here (Enter, the wand, a voice transcript, 'Look it up with AI', Retry), and the list
  // jumps to the top as it starts, where its card or its banner will show.
  const [aiSubmitKey, setAiSubmitKey] = useState(0);
  const startAISearch = useCallback((query: string) => {
    if (!query.trim()) return;
    setAiSubmitKey(n => n + 1);
    performAISearch(query);
  }, [performAISearch]);

  // Text Analyzer modal state
  const [showTextAnalyzer, setShowTextAnalyzer] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [showJSONImport, setShowJSONImport] = useState(false);

  // Compare mode state
  const [compareMode, setCompareMode] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);

  // Voice search: the transcript becomes the query and is looked up with AI.
  const handleTranscript = useCallback((text: string) => {
    changeQuery(text);
    startAISearch(text);
  }, [changeQuery, startAISearch]);
  // A voice failure shows in the lookup's banner, with no Retry: Retry looks up the typed query, not the recording.
  const reportVoiceError = useCallback(
    (message: string | null) => setSearchError(message ? { message, retryable: false } : null),
    [setSearchError],
  );
  const { state: voiceState, toggleRecording } = useVoiceSearch(isOnline, handleTranscript, reportVoiceError);
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';

  // Touch swipe handling to clear search: a swipe to the right across the search bar
  const clearSwipe = useHorizontalSwipe({
    onSwipeRight: () => {
      if (localSearchQuery.trim()) changeQuery('');
    },
  });

  // Handle keyboard Enter to trigger AI search. While an input method is composing (pinyin, say), Enter commits
  // the composition and Escape dismisses its candidates; both belong to the input method.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (e.key === 'Enter' && localSearchQuery.trim()) {
      e.preventDefault();
      startAISearch(localSearchQuery);
      // On a phone the keyboard would hide the card the lookup brings, so it goes.
      if (PLATFORM.isMobile) e.currentTarget.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (localSearchQuery) {
        changeQuery('');
      } else {
        (e.target as HTMLInputElement).blur();
      }
    }
  };

  // Global Escape (works even when the input is not focused) clears the search, and a second one leaves compare
  // mode. It's the notebook's own Escape, so it stands down while an overlay (DetailView, a modal) is open and
  // for an Escape something else already used, such as closing the tools menu.
  useEffect(() => {
    if (hasOverlay) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      if (localSearchQuery || searchResults) {
        e.preventDefault();
        e.stopPropagation();
        changeQuery('');
      } else if (compareMode) {
        e.preventDefault();
        setCompareMode(false);
        setSelectedForCompare([]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [localSearchQuery, searchResults, compareMode, hasOverlay, changeQuery]);

  // Save a vocab from search results into the unified notebook.
  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    onSave(makeVocabStoredItem(vocab));
  }, [onSave]);

  const { searchQuery, list, searchSettled } = useNotebookSearch({
    items, query: localSearchQuery, sortMode, filterMode, clockBump, matchSavedBases,
  });

  // The header counts the notebook's spellings under the current filter at the list's clock, not the search
  // results: outside a search "N saved" is the listed groups, and "N to review" the ones listed with a Due badge.
  const { saved: savedCount, reviewedToday, toReview } = useMemo(
    () => notebookStats(items, filterMode, list.now),
    [items, filterMode, list.now],
  );
  // The empty-notebook screen is for a notebook with nothing in it, not one the filter or the archive hides.
  const hasSavedItems = useMemo(() => items.some(item => !!item?.data?.id && !item.isDeleted), [items]);
  // Its header holds the tools and the account menu. The list's scrolling may have slid it away, and an empty
  // notebook has nothing to scroll it back with.
  useLayoutEffect(() => {
    if (!hasSavedItems) showHeader();
  }, [hasSavedItems, showHeader]);

  // With nothing listed above the due and archived sections, the list says why and offers the way out.
  const canLookUp = isOnline && !searchResults && !isSearching && !isTranscribing && !!localSearchQuery.trim();
  const listNote = useMemo(() => {
    const note = listNoteFor({
      searchQuery, searchSettled, groupCount: list.groups.length, archivedCount: list.archived.length, filter: filterMode, canLookUp,
    });
    if (!note) return null;
    return <ListNote note={note} onLookUp={() => startAISearch(localSearchQuery)} onShowAll={() => setFilterMode('all')} />;
  }, [list, searchSettled, searchQuery, filterMode, canLookUp, startAISearch, localSearchQuery]);
  const showListNote = listNote !== null;

  // DetailView pages through the section the card was opened from. The list is read when a card opens, so this
  // callback, and the rows it's handed to, outlive list rebuilds. A row's group is the list's own object, or, if a
  // rebuild replaced it, the one with its title.
  const listRef = useLatest(list);
  const openGroup = useCallback((group: ItemGroup, section: NotebookSection, itemIndex: number) => {
    const current = listRef.current;
    const groups = section === 'due' ? current.dueGroups : section === 'archived' ? current.archivedGroups : current.groups;
    let groupIndex = groups.indexOf(group);
    if (groupIndex < 0) groupIndex = groups.findIndex(g => g.title === group.title);
    if (groupIndex < 0) return;
    onViewDetail(groups, groupIndex, itemIndex);
    // The list catches up with the clock behind the card, at low priority so the card's first paint doesn't wait,
    // and what fell due meanwhile is in place when the card closes.
    startTransition(() => setClockBump(n => n + 1));
  }, [listRef, onViewDetail]);

  const searching = !!searchQuery;
  const virtualRows = useMemo(
    () => buildNotebookRows(list, { searching, compareMode, showListNote, showArchived }),
    [list, searching, showArchived, compareMode, showListNote],
  );

  const renderVirtualRow = useCallback((_index: number, row: NotebookRow) => {
    if (row.type === 'list-note') return listNote;

    if (row.type === 'compare-banner') {
      return (
        <CompareBanner
          selectedCount={selectedForCompare.length}
          onExit={() => { setCompareMode(false); setSelectedForCompare([]); }}
        />
      );
    }

    if (row.type === 'due-header') return <DueHeader count={row.count} filter={filterMode} />;

    if (row.type === 'archived-header') return <ArchivedMatchesHeader count={row.count} />;

    if (row.type === 'archived-toggle') {
      return <ArchivedToggle count={row.count} expanded={showArchived} onToggle={() => setShowArchived(open => !open)} />;
    }

    // row.type === 'group'
    const { group, section } = row;

    if (compareMode && section === 'main') {
      const displayWord = getItemTitle(group.items[0]) || group.title;
      const isSelected = selectedForCompare.includes(displayWord);
      const canSelect = selectedForCompare.length < 3 || isSelected;
      const toggleSelected = () => {
        if (isSelected) {
          setSelectedForCompare(prev => prev.filter(w => w !== displayWord));
        } else if (canSelect) {
          setSelectedForCompare(prev => [...prev, displayWord]);
        }
      };

      return (
        <CompareRow
          group={group}
          section={section}
          now={list.now}
          displayWord={displayWord}
          isSelected={isSelected}
          canSelect={canSelect}
          onToggle={toggleSelected}
        />
      );
    }

    // Compare mode's rows sit outside the provider, so their inert cards never show actions.
    return (
      <ActionStackContext.Provider value={actionStack}>
        <div className="px-3 py-1.5">
          <NotebookGroup
            group={group}
            section={section}
            now={list.now}
            onViewDetail={openGroup}
            onDelete={onDelete}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
          />
        </div>
      </ActionStackContext.Provider>
    );
  }, [compareMode, selectedForCompare, showArchived, openGroup, onDelete, onArchive, onUnarchive, listNote, list.now, filterMode, actionStack]);

  // The list scrolls inside this container. React detaches refs while the tab is hidden, and letting go of
  // the container then would unmount the list and lose its place, so only a new container replaces it.
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const attachScrollParent = useCallback((element: HTMLDivElement | null) => {
    if (element) setScrollParent(element);
  }, []);

  // While the search box has the keyboard up, a mostly vertical drag of the list below the header drops it, so the
  // results can be read; a sideways swipe through a word's senses leaves it up. Mice make no touches.
  useEffect(() => {
    if (!searchFocused || !scrollParent) return;
    let start: { x: number; y: number; inHeader: boolean } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      start = touch ? { x: touch.clientX, y: touch.clientY, inHeader: !!headerRef.current?.contains(e.target as Node) } : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!start || !touch) return;
      if (shouldBlurOnDrag({ dx: touch.clientX - start.x, dy: touch.clientY - start.y }, start.inHeader)) {
        start = null;
        searchInputRef.current?.blur();
      }
    };
    scrollParent.addEventListener('touchstart', onTouchStart, { passive: true });
    scrollParent.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      scrollParent.removeEventListener('touchstart', onTouchStart);
      scrollParent.removeEventListener('touchmove', onTouchMove);
    };
  }, [searchFocused, scrollParent, headerRef]);

  // Where the list goes (nextScrollAction): a search's results come into view at the top once they settle, as does
  // the list after a new sort or filter and as an AI lookup starts; emptying the box goes back to the browse spot the
  // first character typed remembered. A jump keeps the header, and through onSyncScroll the nav bar, on screen.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const browseSpotRef = useRef<BrowseSpot | null>(null);
  const typedQuery = localSearchQuery.trim();
  const scrollInputs = useMemo<ListScrollInputs>(() => ({
    query: typedQuery,
    // The list shows the typed query once the deferred search has caught up with it, and a search has settled.
    settled: searchQuery === typedQuery && (!typedQuery || searchSettled),
    sort: sortMode,
    filter: filterMode,
    aiSubmitKey,
  }), [typedQuery, searchQuery, searchSettled, sortMode, filterMode, aiSubmitKey]);
  const shownScrollInputs = useRef(scrollInputs);
  useLayoutEffect(() => {
    const prev = shownScrollInputs.current;
    shownScrollInputs.current = scrollInputs;
    if (prev === scrollInputs || !scrollParent) return;
    const action = nextScrollAction(prev, scrollInputs, browseSpotRef.current !== null);
    if (action.anchor === 'save') {
      // The rows on screen are still the browse list's: a search renders a moment after the typing.
      const headerBottom = headerRef.current?.getBoundingClientRect().bottom ?? -Infinity;
      const visibleTop = Math.max(scrollParent.getBoundingClientRect().top, headerBottom);
      const rendered = Array.from(scrollParent.querySelectorAll<HTMLElement>('[data-item-index]'), row => ({
        index: Number(row.dataset.itemIndex),
        bottom: row.getBoundingClientRect().bottom,
      }));
      const index = firstVisibleRowIndex(rendered, visibleTop);
      browseSpotRef.current = { key: index === null ? undefined : virtualRows[index]?.key, scrollTop: scrollParent.scrollTop };
    }
    if (action.scroll === 'top') {
      scrollParent.scrollTop = 0;
    } else if (action.scroll === 'restore' && browseSpotRef.current) {
      const spot = browseSpotRef.current;
      const index = spot.key === undefined ? -1 : virtualRows.findIndex(row => row.key === spot.key);
      // By the row, under the header, wherever the list has moved it; failing that, by the position.
      if (index >= 0 && virtuosoRef.current) {
        virtuosoRef.current.scrollToIndex({ index, align: 'start', offset: -(headerRef.current?.offsetHeight ?? 0) });
      } else {
        scrollParent.scrollTop = spot.scrollTop;
      }
    }
    if (action.scroll) {
      syncScrollPosition(scrollParent);
      onSyncScroll?.(scrollParent);
    }
    if (action.anchor === 'drop') browseSpotRef.current = null;
  }, [scrollInputs, scrollParent, virtualRows, headerRef, syncScrollPosition, onSyncScroll]);

  // An empty notebook keeps its header, with the tools and the account menu, over an invitation in place of the
  // list. The header and the sheets keep their place when the first word arrives, so an open menu or sheet
  // carries on.
  return (
    <div
      ref={attachScrollParent}
      className={`h-full overflow-y-auto overflow-x-hidden bg-slate-50${hasSavedItems ? '' : ' flex flex-col'}`}
      onScroll={handleListScroll}
    >
      <NotebookHeader
        headerRef={headerRef}
        savedCount={savedCount}
        reviewedToday={reviewedToday}
        toReviewCount={toReview}
        isOnline={isOnline}
        toolsMenu={
          <NotebookToolsMenu
            isOnline={isOnline}
            onAnalyzeText={() => setShowTextAnalyzer(true)}
            onBatchImport={() => setShowBatchImport(true)}
            onImportJSON={() => setShowJSONImport(true)}
            onDownloadOfflineImages={onDownloadOfflineImages}
            onForceSync={onForceSync}
            syncStatus={syncStatus}
            onGenerateAllSpeech={onGenerateAllSpeech}
            speechGenerationRunning={!!ttsGenProgress?.isRunning}
            onRestoreImagesToServer={onRestoreImagesToServer}
            imageRestoreRunning={imageRestoreRunning}
            onFindDuplicates={onFindDuplicates}
            onShowShortcuts={onShowShortcuts}
          />
        }
        empty={!hasSavedItems}
        compareMode={compareMode}
        onToggleCompare={() => {
          setCompareMode(prev => !prev);
          setSelectedForCompare([]);
        }}
        filterMode={filterMode}
        onCycleFilter={() => setFilterMode(nextNotebookFilter)}
        sortMode={sortMode}
        onCycleSort={() => setSortMode(nextNotebookSort)}
        user={user}
        onSignOut={onSignOut}
        onViewRefusedReviews={onViewRefusedReviews}
      >
        {/* Search Bar - swipe right to clear. An empty notebook's box is in its invitation instead. */}
        {hasSavedItems && (
          <NotebookSearchBar
            query={localSearchQuery}
            onQueryChange={changeQuery}
            onKeyDown={handleSearchKeyDown}
            onTouchStart={clearSwipe.onTouchStart}
            onTouchEnd={clearSwipe.onTouchEnd}
            isOnline={isOnline}
            isRecording={isRecording}
            isTranscribing={isTranscribing}
            isSearching={isSearching}
            onToggleRecording={toggleRecording}
            onSearchWithAI={() => startAISearch(localSearchQuery)}
            onClear={() => changeQuery('')}
            inputRef={searchInputRef}
            onFocusChange={setSearchFocused}
          />
        )}
        {/* Batch Import Progress Banner, part of the header so it hides and shows with it */}
        {batchImportProgress?.isRunning && <BatchImportBanner progress={batchImportProgress} />}
      </NotebookHeader>

      {hasSavedItems ? (
        <>
          {/* AI Search Results */}
          {searchError && (
            <SearchErrorBanner
              message={searchError.message}
              onRetry={retryOffered(searchError, isOnline, localSearchQuery) ? () => startAISearch(localSearchQuery) : undefined}
            />
          )}

          {searchResults && searchResults.vocabs && searchResults.vocabs.length > 0 && (
            <SearchResultsCarousel
              vocabs={searchResults.vocabs}
              onSave={handleSaveVocab}
              isVocabSaved={isVocabSaved}
              onSearch={onSearch}
              onSaveSentence={onSaveSentence}
              isSentenceSaved={isSentenceSaved}
              keyboardEnabled={!hasOverlay}
            />
          )}

          <div className="w-full max-w-screen-md lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl mx-auto pb-[calc(5rem+env(safe-area-inset-bottom))]">
            {scrollParent && (
              <Virtuoso
                ref={virtuosoRef}
                customScrollParent={scrollParent}
                data={virtualRows}
                overscan={400}
                computeItemKey={virtualRowKey}
                itemContent={renderVirtualRow}
              />
            )}
          </div>
        </>
      ) : (
        // Typing stays on this screen, in the same box: its search opens the search sheet, where the first word
        // is saved.
        <EmptyNotebook query={localSearchQuery} onQueryChange={changeQuery} onSearch={onSearch} />
      )}

      {/* Text Analyzer Modal */}
      <TextAnalyzer
        isOpen={showTextAnalyzer}
        onClose={() => setShowTextAnalyzer(false)}
        onSave={onSave}
        savedItems={items}
        isOnline={isOnline}
      />

      {/* Batch Import Modal */}
      <BatchImport
        isOpen={showBatchImport}
        onClose={() => setShowBatchImport(false)}
        onSubmit={onBatchImport}
      />

      {/* JSON Import Modal */}
      <JSONImport
        isOpen={showJSONImport}
        onClose={() => setShowJSONImport(false)}
        onImported={onJSONImported}
      />

      {/* Compare floating action button */}
      {compareMode && selectedForCompare.length >= 2 && (
        <CompareSelectedButton
          count={selectedForCompare.length}
          onCompare={() => {
            onCompare(selectedForCompare);
            setCompareMode(false);
            setSelectedForCompare([]);
          }}
        />
      )}
    </div>
  );
};
