import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { StoredItem, SyncStatus, AppUser, ItemGroup, VocabCard, SearchResult } from '../types';
import { TextAnalyzer } from '../components/TextAnalyzer';
import { BatchImport } from '../components/BatchImport';
import { JSONImport } from '../components/JSONImport';
import { makeVocabStoredItem } from '../services/items';
import {
  buildNotebookRows, countSavedSpellings, listNoteFor, nextNotebookFilter, nextNotebookSort, notebookStats,
  type NotebookFilter, type NotebookRow, type NotebookSection, type NotebookSort,
} from '../services/notebookList';
import { isTypingTarget } from '../components/keyboardTarget';
import { NotebookGroup } from './notebook/NotebookGroup';
import { SearchResultsCarousel } from './notebook/SearchResultsCarousel';
import { NotebookHeader } from './notebook/NotebookHeader';
import { NotebookToolsMenu } from './notebook/NotebookToolsMenu';
import { NotebookSearchBar } from './notebook/NotebookSearchBar';
import { ArchivedToggle, DueHeader, ListNote } from './notebook/ListRows';
import { CompareBanner, CompareRow, CompareSelectedButton } from './notebook/CompareMode';
import { EmptyNotebook } from './notebook/EmptyNotebook';
import { BatchImportBanner, type BatchImportProgress } from './notebook/BatchImportBanner';
import { SearchErrorBanner } from './notebook/SearchErrorBanner';
import { useAutoHidingHeader } from './notebook/useAutoHidingHeader';
import { useNotebookAISearch } from './notebook/useNotebookAISearch';
import { useVoiceSearch } from './notebook/useVoiceSearch';
import { useNotebookSearch } from './notebook/useNotebookSearch';
import { useHorizontalSwipe } from './notebook/useHorizontalSwipe';

const virtualRowKey = (_index: number, row: NotebookRow) => row.key;

interface NotebookProps {
  items: StoredItem[];
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: (groups: ItemGroup[], groupIndex: number, itemIndex: number) => void;
  user: AppUser | null;
  onSignIn: () => void;
  onSignOut: () => void;
  syncStatus: SyncStatus;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  onForceSync: () => void;
  isOnline: boolean;
  /** Unused: the 'notebook-search' listener that read it is gone. App still passes it until it stops (handoff). */
  hasSavedVariant?: (query: string) => boolean;
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
}

export const NotebookView: React.FC<NotebookProps> = React.memo(({
    items, onDelete, onSearch, onViewDetail,
    user, onSignIn, onSignOut, syncStatus, onScroll, onForceSync, isOnline,
    isVocabSaved, onFindDuplicates, onArchive, onUnarchive, onSave, onCompare,
    onSaveSentence, isSentenceSaved, hasOverlay,
    onBatchImport, batchImportProgress, onJSONImported,
    onGenerateAllSpeech, ttsGenProgress,
    onRestoreImagesToServer, imageRestoreRunning, onDownloadOfflineImages
}) => {
  const [sortMode, setSortMode] = useState<NotebookSort>('familiarity');
  const [filterMode, setFilterMode] = useState<NotebookFilter>('vocab'); // Default to vocab only
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const { headerRef, handleScroll } = useAutoHidingHeader(onScroll);

  // AI Search state
  const {
    isSearching, searchResults, searchError, setSearchError, performAISearch, clearSearchResults,
  } = useNotebookAISearch(isOnline, localSearchQuery);

  // Text Analyzer modal state
  const [showTextAnalyzer, setShowTextAnalyzer] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [showJSONImport, setShowJSONImport] = useState(false);

  // Compare mode state
  const [compareMode, setCompareMode] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);

  // Voice search: the transcript becomes the query and is looked up with AI.
  const handleTranscript = useCallback((text: string) => {
    setLocalSearchQuery(text);
    performAISearch(text);
  }, [performAISearch]);
  const { isRecording, isTranscribing, toggleRecording } = useVoiceSearch(isOnline, handleTranscript, setSearchError);

  // Touch swipe handling to clear search: a swipe to the right across the search bar
  const clearSwipe = useHorizontalSwipe({
    onSwipeRight: () => {
      if (localSearchQuery.trim()) {
        setLocalSearchQuery('');
        clearSearchResults();
      }
    },
  });

  // Handle keyboard Enter to trigger AI search
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && localSearchQuery.trim()) {
      e.preventDefault();
      performAISearch(localSearchQuery);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (localSearchQuery) {
        setLocalSearchQuery('');
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
        setLocalSearchQuery('');
        clearSearchResults();
      } else if (compareMode) {
        e.preventDefault();
        setCompareMode(false);
        setSelectedForCompare([]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [localSearchQuery, searchResults, compareMode, hasOverlay, clearSearchResults]);

  // Save a vocab from search results into the unified notebook.
  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    onSave(makeVocabStoredItem(vocab));
  }, [onSave]);

  const { searchQuery, list, searchSettled } = useNotebookSearch(items, localSearchQuery, sortMode, filterMode);

  // "N saved" counts the notebook's spellings under the current filter, not the search results. Outside a
  // search they're the listed groups; during one they're counted apart, once per search rather than per key.
  const searching = !!searchQuery;
  const savedWhileSearching = useMemo(
    () => (searching ? countSavedSpellings(items, filterMode) : 0),
    [items, filterMode, searching],
  );
  const savedCount = searching ? savedWhileSearching : list.groups.length;
  // The empty-notebook screen is for a notebook with nothing in it, not one the filter or the archive hides.
  const hasSavedItems = useMemo(() => items.some(item => !!item?.data?.id && !item.isDeleted), [items]);

  // With nothing listed above the due and archived sections, the list says why and offers the way out.
  const canLookUp = isOnline && !searchResults && !isSearching && !isTranscribing && !!localSearchQuery.trim();
  const listNote = useMemo(() => {
    const note = listNoteFor({
      searchQuery, searchSettled, groupCount: list.groups.length, archivedCount: list.archived.length, filter: filterMode, canLookUp,
    });
    if (!note) return null;
    return <ListNote note={note} onLookUp={() => performAISearch(localSearchQuery)} onShowAll={() => setFilterMode('all')} />;
  }, [list, searchSettled, searchQuery, filterMode, canLookUp, performAISearch, localSearchQuery]);
  const showListNote = listNote !== null;

  // DetailView pages through the section the card was opened from.
  const openGroup = useCallback((section: NotebookSection, groupIndex: number, itemIndex: number) => {
    const groups = section === 'due' ? list.dueGroups : section === 'archived' ? list.archivedGroups : list.groups;
    onViewDetail(groups, groupIndex, itemIndex);
  }, [list, onViewDetail]);

  const virtualRows = useMemo(
    () => buildNotebookRows(list, { compareMode, showListNote, showArchived }),
    [list, showArchived, compareMode, showListNote],
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

    if (row.type === 'due-header') return <DueHeader count={row.count} />;

    if (row.type === 'archived-toggle') {
      return <ArchivedToggle count={row.count} expanded={showArchived} onToggle={() => setShowArchived(open => !open)} />;
    }

    // row.type === 'group'
    const { group, groupIndex, section } = row;

    if (compareMode && section === 'main') {
      const firstItem = group.items[0];
      const displayWord = firstItem
        ? (firstItem.type === 'phrase'
            ? (firstItem.data as SearchResult).query
            : (firstItem.data as VocabCard).word) || group.title
        : group.title;
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
          groupIndex={groupIndex}
          displayWord={displayWord}
          isSelected={isSelected}
          canSelect={canSelect}
          onToggle={toggleSelected}
        />
      );
    }

    return (
      <div className="px-3 py-1.5">
        <NotebookGroup
          group={group}
          section={section}
          groupIndex={groupIndex}
          onViewDetail={openGroup}
          onDelete={onDelete}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
        />
      </div>
    );
  }, [compareMode, selectedForCompare, showArchived, openGroup, onDelete, onArchive, onUnarchive, listNote]);

  const { reviewedToday, dueCount } = useMemo(() => notebookStats(items, Date.now()), [items]);

  // The list scrolls inside this container. React detaches refs while the tab is hidden, and letting go of
  // the container then would unmount the list and lose its place, so only a new container replaces it.
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const attachScrollParent = useCallback((element: HTMLDivElement | null) => {
    if (element) setScrollParent(element);
  }, []);

  if (!hasSavedItems && !localSearchQuery) {
    return <EmptyNotebook query={localSearchQuery} onQueryChange={setLocalSearchQuery} onSearch={onSearch} />;
  }

  return (
    <div
      ref={attachScrollParent}
      className="h-full overflow-y-auto overflow-x-hidden bg-slate-50"
      onScroll={handleScroll}
    >
      <NotebookHeader
        headerRef={headerRef}
        savedCount={savedCount}
        reviewedToday={reviewedToday}
        dueCount={dueCount}
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
          />
        }
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
        onSignIn={onSignIn}
        onSignOut={onSignOut}
      >
        {/* Search Bar - swipe right to clear */}
        <NotebookSearchBar
          query={localSearchQuery}
          onQueryChange={setLocalSearchQuery}
          onKeyDown={handleSearchKeyDown}
          onTouchStart={clearSwipe.onTouchStart}
          onTouchEnd={clearSwipe.onTouchEnd}
          isOnline={isOnline}
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          isSearching={isSearching}
          onToggleRecording={toggleRecording}
          onSearchWithAI={() => performAISearch(localSearchQuery)}
          onClear={() => {
            setLocalSearchQuery('');
            clearSearchResults();
          }}
        />
      </NotebookHeader>

      {/* Batch Import Progress Banner */}
      {batchImportProgress?.isRunning && <BatchImportBanner progress={batchImportProgress} />}

      {/* AI Search Results */}
      {searchError && (
        <SearchErrorBanner
          message={searchError}
          onRetry={localSearchQuery.trim() ? () => performAISearch(localSearchQuery) : undefined}
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
            customScrollParent={scrollParent}
            data={virtualRows}
            overscan={400}
            computeItemKey={virtualRowKey}
            itemContent={renderVirtualRow}
          />
        )}
      </div>

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
});
