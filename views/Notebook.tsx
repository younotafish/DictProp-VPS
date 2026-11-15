import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { StoredItem, SyncStatus, AppUser, ItemGroup, VocabCard, SearchResult } from '../types';
import { TextAnalyzer } from '../components/TextAnalyzer';
import { BatchImport } from '../components/BatchImport';
import { JSONImport } from '../components/JSONImport';
import { analyzeInput, transcribeAudio } from '../services/api';
import { makeVocabStoredItem } from '../services/items';
import {
  buildNotebookList, buildNotebookRows, countSavedSpellings, findFuzzyMatches, findLiteralMatches, listNoteFor, nextNotebookFilter,
  nextNotebookSort, notebookStats, type NotebookFilter, type NotebookList, type NotebookRow, type NotebookSection, type NotebookSort,
} from '../services/notebookList';
import { speakWord, ensureTTS } from '../services/lazyTts';
import { error as logError } from '../services/logger';
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
  // Defer the heavy grouping/search pipeline so typing stays responsive on large libraries: the input
  // updates immediately (localSearchQuery) while the filtered/grouped list catches up a tick behind.
  const deferredSearchQuery = React.useDeferredValue(localSearchQuery);
  const [showArchived, setShowArchived] = useState(false);
  const lastScrollY = useRef(0);
  // Hidden and shown by class, so scrolling never re-renders the notebook.
  const headerRef = useRef<HTMLDivElement>(null);
  
  // AI Search state
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchGenerationIdRef = useRef(0); // Incremented on each search to discard stale analysis results
  
  // Text Analyzer modal state
  const [showTextAnalyzer, setShowTextAnalyzer] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [showJSONImport, setShowJSONImport] = useState(false);

  // Compare mode state
  const [compareMode, setCompareMode] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // Clean up MediaRecorder and release microphone on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Touch swipe handling to clear search
  const touchStart = useRef<{x: number, y: number} | null>(null);
  const SWIPE_THRESHOLD = 50;

  const handleSwipeTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleSwipeTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    
    // Check if user is selecting text - don't interfere with text selection
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      touchStart.current = null;
      return;
    }
    
    const diffX = e.changedTouches[0].clientX - touchStart.current.x;
    const diffY = e.changedTouches[0].clientY - touchStart.current.y;
    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);
    
    // Only trigger swipe if horizontal movement is significantly greater than vertical
    // and swipe is to the right (positive diffX)
    if (diffX > 0 && absX > absY * 1.5 && absX > SWIPE_THRESHOLD && localSearchQuery.trim()) {
      setLocalSearchQuery('');
      setSearchResults(null);
      setSearchError(null);
    }
    touchStart.current = null;
  };

  // AI Search function
  const performAISearch = useCallback(async (query: string) => {
    if (!query.trim() || !isOnline) return;

    setIsSearching(true);
    setSearchError(null);
    setSearchResults(null);

    // Increment generation ID so a superseded search's result is discarded when it lands
    const currentGenId = ++searchGenerationIdRef.current;

    try {
      const result = await analyzeInput(query.trim());
      if (searchGenerationIdRef.current !== currentGenId) return; // Superseded by new search
      setSearchResults(result);

      // Prepare the API audio for the example sentences up front (generate if needed) so the first
      // tap plays instantly from the cache instead of hitting a cache-miss fallback.
      ensureTTS((result.vocabs || []).flatMap(v => v.examples || []));

      // Auto-pronounce the word once when results arrive
      if (result.vocabs && result.vocabs.length > 0) {
        const wordToSpeak = result.vocabs[0].word || query.trim();
        setTimeout(() => speakWord(wordToSpeak), 100);

        // The immediate result is intentionally text-only. The Mac's local enrichment cycle creates
        // the advanced metadata and image after the item is saved.
      }
    } catch (err: any) {
      logError('AI Search failed:', err);
      setSearchError(err.message || 'Search failed. Please try again.');
    } finally {
      setIsSearching(false);
    }
  }, [isOnline]);

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

  // Voice recording functions
  const startRecording = useCallback(async () => {
    if (!isOnline) return;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      
      // Try to use audio/webm with opus codec, fallback to default
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
        
        if (audioChunksRef.current.length === 0) return;
        
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        
        // Transcribe the audio
        setIsTranscribing(true);
        setSearchError(null);
        
        try {
          const transcribedText = await transcribeAudio(audioBlob);
          if (transcribedText.trim()) {
            setLocalSearchQuery(transcribedText.trim());
            // Auto-search after transcription
            performAISearch(transcribedText.trim());
          }
        } catch (err: any) {
          logError('Transcription failed:', err);
          setSearchError(err.message === 'QUOTA_EXCEEDED' 
            ? 'Voice transcription quota exceeded. Please type your search.' 
            : 'Voice transcription failed. Please try again.');
        } finally {
          setIsTranscribing(false);
        }
      };
      
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err: any) {
      logError('Failed to start recording:', err);
      setSearchError('Microphone access denied. Please enable microphone permissions.');
    }
  }, [isOnline, performAISearch]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

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
        setSearchResults(null);
        setSearchError(null);
      } else if (compareMode) {
        e.preventDefault();
        setCompareMode(false);
        setSelectedForCompare([]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [localSearchQuery, searchResults, compareMode, hasOverlay]);

  // Clear search results when query is cleared
  useEffect(() => {
    if (!localSearchQuery.trim()) {
      setSearchResults(null);
      setSearchError(null);
    }
  }, [localSearchQuery]);

  // Save a vocab from search results into the unified notebook.
  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    onSave(makeVocabStoredItem(vocab));
  }, [onSave]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;

    // Top buffer zone
    if (currentScrollY < 50) {
      headerRef.current?.classList.remove('-translate-y-full');
    } else if (Math.abs(currentScrollY - lastScrollY.current) > 10) {
      headerRef.current?.classList.toggle('-translate-y-full', currentScrollY > lastScrollY.current);
    }

    lastScrollY.current = currentScrollY;
    onScroll(e);
  }, [onScroll]);
  
  const searchQuery = deferredSearchQuery.trim();
  // A query no word contains, as each keystroke of a word the notebook doesn't have yet is, falls back to a
  // fuzzy scan of every spelling that takes tens of ms. It waits for typing to pause, and until then the
  // list keeps its last results rather than flash empty.
  const [pausedQuery, setPausedQuery] = useState(searchQuery);
  useEffect(() => {
    const timer = window.setTimeout(() => setPausedQuery(searchQuery), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);
  const literalMatches = useMemo(
    () => (searchQuery ? findLiteralMatches(items, searchQuery) : null),
    [items, searchQuery],
  );
  const fuzzyReady = !!searchQuery && !literalMatches && pausedQuery === searchQuery;
  const shownList = useRef<NotebookList | null>(null);
  const list = useMemo(() => {
    if (!searchQuery) return buildNotebookList(items, null, sortMode, filterMode);
    const matches = literalMatches ?? (fuzzyReady ? findFuzzyMatches(items, searchQuery) : null);
    if (!matches && shownList.current) return shownList.current;
    return buildNotebookList(items, matches ?? [], sortMode, filterMode);
  }, [items, searchQuery, literalMatches, fuzzyReady, sortMode, filterMode]);
  useEffect(() => { shownList.current = list; }, [list]);
  // The list shows this query's results, not the last query's kept on screen while the fuzzy scan waits.
  const searchSettled = !!searchQuery && (!!literalMatches || fuzzyReady);

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
          onTouchStart={handleSwipeTouchStart}
          onTouchEnd={handleSwipeTouchEnd}
          isOnline={isOnline}
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          isSearching={isSearching}
          onToggleRecording={toggleRecording}
          onSearchWithAI={() => performAISearch(localSearchQuery)}
          onClear={() => {
            setLocalSearchQuery('');
            setSearchResults(null);
            setSearchError(null);
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
