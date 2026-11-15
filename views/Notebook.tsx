import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { StoredItem, SyncStatus, AppUser, ItemGroup, VocabCard, SearchResult } from '../types';
import { BookOpen, Layers, Loader2, RefreshCw, Type, ArrowDownAZ, Sparkles, Filter, WifiOff, Archive, ChevronDown, ChevronUp, Search, X, Wand2, Mic, MicOff, ScanText, Scale, Check, ListPlus, FileJson, UploadCloud, GitMerge, Volume2, MoreHorizontal, Download } from 'lucide-react';
import { UserMenu } from '../components/UserMenu';
import { SpeechStyleToggle } from '../components/SpeechStyleToggle';
import { PlaybackSpeedToggle } from '../components/PlaybackSpeedToggle';
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

const virtualRowKey = (_index: number, row: NotebookRow) => row.key;
const noop = () => {};

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
  batchImportProgress: { current: number; total: number; skipped: number; failed: number; saved: number; isRunning: boolean } | null;
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
  const [showMaintenanceMenu, setShowMaintenanceMenu] = useState(false);
  const maintenanceMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMaintenanceMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (maintenanceMenuRef.current && !maintenanceMenuRef.current.contains(event.target as Node)) {
        setShowMaintenanceMenu(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); // closing the menu is all this Escape does
      setShowMaintenanceMenu(false);
      maintenanceMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showMaintenanceMenu]);

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
    return (
      <div className="mx-3 mt-3 px-4 py-5 bg-white border border-dashed border-slate-200 rounded-2xl text-center">
        <p className="text-sm text-slate-500">{note.message}</p>
        {(note.offerLookUp || note.offerShowAll) && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {note.offerLookUp && (
              <button
                onClick={() => performAISearch(localSearchQuery)}
                className="min-h-11 px-4 inline-flex items-center gap-2 rounded-xl bg-violet-50 text-violet-700 text-sm font-semibold hover:bg-violet-100 transition-colors"
              >
                <Wand2 size={16} /> Look it up with AI
              </button>
            )}
            {note.offerShowAll && (
              <button
                onClick={() => setFilterMode('all')}
                className="min-h-11 px-4 inline-flex items-center gap-2 rounded-xl bg-indigo-50 text-indigo-700 text-sm font-semibold hover:bg-indigo-100 transition-colors"
              >
                <Filter size={16} /> Show all items
              </button>
            )}
          </div>
        )}
      </div>
    );
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
        <div className="px-3 pt-3">
          <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <Scale size={16} className="text-indigo-500" />
              <span className="text-sm font-medium text-indigo-700">
                Select 2-3 words to compare
              </span>
              {selectedForCompare.length > 0 && (
                <span className="text-xs font-bold text-indigo-500 bg-indigo-100 px-2 py-0.5 rounded-full">
                  {selectedForCompare.length} selected
                </span>
              )}
            </div>
            <button
              onClick={() => { setCompareMode(false); setSelectedForCompare([]); }}
              className="text-indigo-400 hover:text-indigo-600 p-1 rounded-full hover:bg-indigo-100 transition-colors"
              title="Exit compare mode"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      );
    }

    if (row.type === 'due-header') {
      return (
        <div className="px-3 mt-4 pt-3 border-t border-dashed border-orange-200">
          <div className="flex items-center gap-2 px-1 mb-3">
            <span className="text-[10px] font-bold text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full uppercase tracking-wide">Due for Review</span>
            <span className="text-xs text-slate-400">{row.count} words to revisit</span>
          </div>
        </div>
      );
    }

    if (row.type === 'archived-toggle') {
      return (
        <div className="px-3 mt-6 pt-4 border-t-2 border-slate-200">
          <button
            onClick={() => setShowArchived(open => !open)}
            className="w-full flex items-center justify-between px-4 py-3 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
          >
            <div className="flex items-center gap-3">
              <Archive size={18} className="text-slate-500" />
              <span className="font-bold text-slate-700">Archived</span>
              <span className="text-sm text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full">
                {row.count} {row.count === 1 ? 'item' : 'items'}
              </span>
            </div>
            {showArchived ? (
              <ChevronUp size={18} className="text-slate-500" />
            ) : (
              <ChevronDown size={18} className="text-slate-500" />
            )}
          </button>
        </div>
      );
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
        <div className="px-3 py-1.5">
          <div
            role="checkbox"
            tabIndex={0}
            aria-checked={isSelected}
            aria-disabled={!canSelect}
            aria-label={displayWord}
            className={`relative cursor-pointer transition-all ${isSelected ? 'ring-2 ring-indigo-400 rounded-2xl' : ''}`}
            onClick={toggleSelected}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                e.preventDefault();
                toggleSelected();
              }
            }}
          >
            <div className={`absolute top-3 right-3 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
              isSelected
                ? 'bg-indigo-500 border-indigo-500 text-white'
                : canSelect
                  ? 'bg-white border-slate-300'
                  : 'bg-slate-100 border-slate-200 opacity-50'
            }`}>
              {isSelected && <Check size={14} />}
            </div>
            <div className="pointer-events-none" inert>
              <NotebookGroup
                group={group}
                section={section}
                groupIndex={groupIndex}
                onViewDetail={noop}
                onDelete={noop}
              />
            </div>
          </div>
        </div>
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
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50">
        <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
          <BookOpen size={32} className="text-indigo-300" />
        </div>
        <h3 className="text-xl font-bold text-slate-700 mb-2">Your notebook is empty</h3>
        <p className="text-sm mb-8 max-w-xs mx-auto">Search for a word or phrase to get started.</p>

        <div className="w-full max-w-sm">
          <form onSubmit={(e) => { e.preventDefault(); if (localSearchQuery.trim()) onSearch(localSearchQuery.trim()); }} className="relative">
            <input
              type="text"
              value={localSearchQuery}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              placeholder="Search a word or phrase..."
              className="w-full px-4 py-3 pr-12 rounded-xl border border-slate-200 bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
              autoFocus
            />
            <button type="submit" className="absolute right-3 top-1/2 -translate-y-1/2 text-indigo-500 hover:text-indigo-700">
              <Search size={20} />
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={attachScrollParent}
      className="h-full overflow-y-auto overflow-x-hidden bg-slate-50"
      onScroll={handleScroll}
    >
      {/* Header */}
      <div ref={headerRef} className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200/50 transition-transform duration-300">
        <div className="px-4 sm:px-6 py-4 flex justify-between items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-slate-900">Notebook</h2>
            <p className="text-xs text-slate-500 font-medium truncate">{savedCount} saved · {reviewedToday} reviewed today · {dueCount} due</p>
          </div>
          <div className="flex flex-wrap md:flex-nowrap items-center justify-end gap-1 min-w-0">
            {isOnline && (
              <div className="relative shrink-0" ref={maintenanceMenuRef}>
                <button
                  onClick={() => setShowMaintenanceMenu(open => !open)}
                  className="w-11 h-11 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
                  aria-label="Notebook tools"
                  aria-haspopup="menu"
                  aria-expanded={showMaintenanceMenu}
                  title="Notebook tools"
                >
                  <MoreHorizontal size={20} />
                </button>
                {showMaintenanceMenu && (
                  <div role="menu" className="absolute right-0 top-full mt-1 w-64 max-h-[70vh] overflow-y-auto bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-50">
                    <div className="min-h-11 px-3 py-2 flex items-center justify-between gap-3 border-b border-slate-100">
                      <span className="text-sm text-slate-600">Speech playback</span>
                      <div className="flex items-center gap-1">
                        <SpeechStyleToggle className="shrink-0" />
                        <PlaybackSpeedToggle className="shrink-0 bg-slate-100 hover:bg-slate-200" />
                      </div>
                    </div>
                    <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); setShowTextAnalyzer(true); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
                      <ScanText size={17} /> Analyze text
                    </button>
                    <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); setShowBatchImport(true); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
                      <ListPlus size={17} /> Batch import
                    </button>
                    <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); setShowJSONImport(true); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
                      <FileJson size={17} /> Import JSON
                    </button>
                    <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onDownloadOfflineImages(); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
                      <Download size={17} /> Download image pack
                    </button>
                    <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onForceSync(); }} disabled={syncStatus === 'syncing'} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                      {syncStatus === 'syncing' ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />} Sync now
                    </button>
                    <div className="h-px bg-slate-100 my-1" />
                    <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onGenerateAllSpeech(); }} disabled={ttsGenProgress?.isRunning} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                      {ttsGenProgress?.isRunning ? <Loader2 size={17} className="animate-spin" /> : <Volume2 size={17} />} Generate speech cache
                    </button>
                    <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onRestoreImagesToServer(); }} disabled={imageRestoreRunning} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                      {imageRestoreRunning ? <Loader2 size={17} className="animate-spin" /> : <UploadCloud size={17} />} Restore server images
                    </button>
                    <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onFindDuplicates(); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
                      <GitMerge size={17} /> Merge duplicates
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* Compare mode toggle */}
            {isOnline && (
              <button
                onClick={() => {
                  setCompareMode(prev => !prev);
                  setSelectedForCompare([]);
                }}
                className={`w-11 h-11 shrink-0 flex items-center justify-center rounded-full transition-colors ${
                  compareMode 
                    ? 'text-indigo-600 bg-indigo-100' 
                    : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'
                }`}
                title={compareMode ? 'Exit compare mode' : 'Compare words — select 2-3 to compare'}
              >
                <Scale size={16} />
              </button>
            )}
            <button
              onClick={() => setFilterMode(nextNotebookFilter)}
              className={`w-11 h-11 shrink-0 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors ${filterMode !== 'all' ? 'text-indigo-600 bg-indigo-50' : 'text-slate-500'}`}
              title={`Filter: ${filterMode === 'all' ? 'All Items' : filterMode === 'vocab' ? 'Vocabulary Only' : 'Phrases Only'}`}
            >
              {filterMode === 'all' && <Filter size={16} />}
              {filterMode === 'vocab' && <Type size={16} />}
              {filterMode === 'phrase' && <Layers size={16} />}
            </button>
            <button
              onClick={() => setSortMode(nextNotebookSort)}
              className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-500 hover:text-indigo-600 transition-colors"
              title={sortMode === 'familiarity' ? 'Sort: Review Priority' : 'Sort: A-Z'}
            >
              {sortMode === 'familiarity' ? <Sparkles size={16} /> : <ArrowDownAZ size={16} />}
            </button>
            <div className="hidden md:block h-4 w-px bg-slate-200 mx-1 shrink-0"></div>
            {!isOnline && (
              <div className="w-11 h-11 flex items-center justify-center text-amber-500 shrink-0" title="Offline">
                <WifiOff size={14} />
              </div>
            )}
            {user && (
              <>
                <div className="hidden md:block h-4 w-[1px] bg-slate-200 mx-1 shrink-0"></div>
                <div className="shrink-0">
                  <UserMenu
                    user={user}
                    onSignIn={onSignIn}
                    onSignOut={onSignOut}
                  />
                </div>
              </>
            )}
          </div>
        </div>
        
        {/* Search Bar - swipe right to clear */}
        <div 
          className="px-6 pb-4"
          onTouchStart={handleSwipeTouchStart}
          onTouchEnd={handleSwipeTouchEnd}
        >
          <div className="relative group">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors" size={16} />
            <input 
              type="text"
              value={localSearchQuery}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={isRecording ? "Listening..." : "Search or look up new word"}
              aria-label="Search the notebook, or look up a new word"
              className="w-full pl-10 pr-24 py-2.5 bg-white border border-slate-200 rounded-xl text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-sm"
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              {/* Voice recording button */}
              {!localSearchQuery && !isSearching && !isTranscribing && (
                <button 
                  onClick={toggleRecording}
                  className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all ${
                    isRecording 
                      ? 'text-rose-500 bg-rose-50 animate-pulse' 
                      : 'text-slate-400 hover:text-violet-600 hover:bg-violet-50'
                  }`}
                  title={isRecording ? 'Stop recording' : 'Voice search'}
                  aria-label={isRecording ? 'Stop recording' : 'Voice search'}
                  disabled={!isOnline}
                >
                  {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
              )}
              {isTranscribing && (
                <div className="flex items-center gap-1.5 text-violet-500">
                  <Loader2 className="animate-spin" size={16} />
                  <span className="text-xs font-medium">Transcribing...</span>
                </div>
              )}
              {localSearchQuery && !isSearching && !isTranscribing && (
                <button 
                  onClick={() => performAISearch(localSearchQuery)}
                  className="w-9 h-9 flex items-center justify-center text-violet-500 hover:text-violet-700 rounded-lg hover:bg-violet-50 transition-colors"
                  title="Search with AI (Enter)"
                  aria-label="Search with AI"
                  disabled={!isOnline}
                >
                  <Wand2 size={16} />
                </button>
              )}
              {isSearching && (
                <div className="w-9 h-9 flex items-center justify-center">
                  <Loader2 className="animate-spin text-violet-500" size={16} />
                </div>
              )}
              {localSearchQuery && !isSearching && !isTranscribing && (
                <button 
                  onClick={() => {
                    setLocalSearchQuery('');
                    setSearchResults(null);
                    setSearchError(null);
                  }}
                  className="w-9 h-9 flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Batch Import Progress Banner */}
      {batchImportProgress?.isRunning && (
        <div className="sticky top-[72px] z-[9] bg-indigo-500 text-white px-4 py-3 shadow-md">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Loader2 className="animate-spin" size={18} />
              <div>
                <p className="font-medium text-sm">Importing words...</p>
                <p className="text-xs text-indigo-200">
                  {batchImportProgress.current}/{batchImportProgress.total} done
                  {batchImportProgress.saved > 0 && ` · ${batchImportProgress.saved} saved`}
                  {batchImportProgress.skipped > 0 && ` · ${batchImportProgress.skipped} skipped`}
                </p>
              </div>
            </div>
            <div className="w-24 h-2 bg-indigo-400 rounded-full overflow-hidden">
              <div
                className="h-full bg-white transition-all duration-300"
                style={{ width: `${batchImportProgress.total > 0 ? (batchImportProgress.current / batchImportProgress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* AI Search Results */}
      {searchError && (
        <div className="px-4 py-3 mx-3 mt-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-center justify-between gap-3">
          <span>{searchError}</span>
          {localSearchQuery.trim() && (
            <button 
              onClick={() => performAISearch(localSearchQuery)}
              className="px-3 py-1.5 bg-rose-100 hover:bg-rose-200 rounded-lg text-rose-700 text-xs font-semibold transition-colors shrink-0"
            >
              Retry
            </button>
          )}
        </div>
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
        <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-0 right-0 flex justify-center z-20 pointer-events-none">
          <button
            onClick={() => {
              onCompare(selectedForCompare);
              setCompareMode(false);
              setSelectedForCompare([]);
            }}
            className="pointer-events-auto px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-full shadow-lg hover:shadow-xl transition-all flex items-center gap-2 duration-200"
          >
            <Scale size={18} />
            Compare {selectedForCompare.length} Words
          </button>
        </div>
      )}
    </div>
  );
});
