import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import Fuse from 'fuse.js';
import { StoredItem, SyncStatus, AppUser, ItemGroup, VocabCard, SearchResult, ProjectInfo } from '../types';
import { Trash2, BookOpen, Layers, Loader2, RefreshCw, Type, ArrowDownAZ, Sparkles, Filter, WifiOff, ChevronLeft, ChevronRight, RotateCcw, Archive, ArchiveRestore, ChevronDown, ChevronUp, Search, X, Wand2, Mic, MicOff, ScanText, Scale, Check, ListPlus, FolderOpen, Settings } from 'lucide-react';
import { Button } from '../components/Button';
import { UserMenu } from '../components/UserMenu';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { VocabCardDisplay } from '../components/VocabCard';
import { TextAnalyzer } from '../components/TextAnalyzer';
import { BatchImport } from '../components/BatchImport';
import { ProjectManager } from '../components/ProjectManager';
import { useWheelNavigation } from '../hooks';
import { analyzeInput, generateIllustration, transcribeAudio } from '../services/api';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { speak } from '../services/speech';
import { warn, error as logError } from '../services/logger';

interface NotebookItemProps {
  item: StoredItem;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: () => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  // For carousel mode
  totalInGroup?: number;
  indexInGroup?: number;
}

const NotebookItem: React.FC<NotebookItemProps> = React.memo(({
  item, isOpen, onOpen, onClose, onDelete, onSearch, onViewDetail, onArchive, onUnarchive, totalInGroup = 1, indexInGroup = 0
}) => {
  const [showActions, setShowActions] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const LONG_PRESS_MS = 500;

  const handlePressStart = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      setShowActions(true);
    }, LONG_PRESS_MS);
  };

  const handlePressEnd = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        window.clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  const handleClick = () => {
    if (showActions) {
      setShowActions(false);
      return;
    }
    onViewDetail();
  };

  const isPhrase = item.type === 'phrase';
  const title = isPhrase 
    ? (item.data as any).query 
    : (item.data as any).word;
  const subtitle = isPhrase 
    ? (item.data as any).translation 
    : (item.data as any).chinese;
  
  const ipa = isPhrase ? (item.data as any).pronunciation : (item.data as any).ipa;
  const examples = !isPhrase ? (item.data as any).examples : [];
  const history = !isPhrase ? (item.data as any).history : null;
  const sense = !isPhrase ? (item.data as any).sense : null;

  const nextReview = item.srs?.nextReview ?? Date.now();
  const isDue = nextReview <= Date.now();
  const intervalDays = Math.round((item.srs?.interval ?? 0) / (24 * 60));

  return (
    <div className="relative overflow-hidden rounded-2xl shadow-sm border border-slate-100 bg-slate-50">
      {/* Main Card */}
      <div
        onClick={handleClick}
        onMouseDown={handlePressStart}
        onMouseUp={handlePressEnd}
        onMouseLeave={handlePressEnd}
        onTouchStart={(e) => { handlePressStart(); }}
        onTouchEnd={handlePressEnd}
        className="bg-white p-4 relative cursor-pointer"
        style={{ touchAction: 'pan-y' }}
      >
        {/* SRS Indicator Strip */}
        <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${isDue ? 'bg-orange-400' : (intervalDays > 21 ? 'bg-emerald-400' : 'bg-slate-200')}`}></div>

        <div className="pl-3 pr-2">
          <div className="mb-2">
            <h4 className="font-bold text-slate-900 text-lg leading-tight line-clamp-2" title={title}>{title}</h4>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              {ipa && (
                <PronunciationBlock 
                  text={title} 
                  ipa={ipa} 
                  className="text-xs py-0.5 px-1.5 min-h-[24px] bg-slate-50 border border-slate-100" 
                />
              )}
              {sense && totalInGroup > 1 && (
                <span className="text-[10px] font-medium text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full truncate max-w-[120px]" title={sense}>
                  {sense}
                </span>
              )}
              {isDue && <span className="text-[10px] font-bold text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full uppercase tracking-wide">Due</span>}
            </div>
          </div>
          <p className="text-sm text-slate-500 truncate mb-2">{subtitle}</p>

          {(examples?.length > 0 || history) && (
            <div className="space-y-2 mt-2 pt-2 border-t border-slate-50">
              {examples?.length > 0 && (
                <div className="text-xs text-slate-600 italic border-l-2 border-indigo-200 pl-2 line-clamp-2">
                  "{(examples[0] || '').replace(/\[\[(.+?)\]\]/g, '$1')}"
                </div>
              )}
              {history && (
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  <span className="font-bold uppercase tracking-wider text-[9px] text-slate-300 mr-1">Origin</span>
                  <span className="line-clamp-2">{history}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Long-press actions */}
      {showActions && (
        <div className="absolute top-3 right-3 flex flex-col gap-2 z-20">
          <button 
            onClick={(e) => { e.stopPropagation(); onSearch(title); setShowActions(false); }}
            className="p-2 bg-white text-indigo-500 shadow rounded-full hover:bg-indigo-50 active:scale-95 transition-all"
            title="Refresh / Search Again"
          >
            <RefreshCw size={18} />
          </button>
          {item.isArchived ? (
            onUnarchive && (
              <button 
                onClick={(e) => { e.stopPropagation(); onUnarchive(item.data.id); setShowActions(false); }}
                className="p-2 bg-white text-emerald-500 shadow rounded-full hover:bg-emerald-50 active:scale-95 transition-all"
                title="Unarchive"
              >
                <ArchiveRestore size={18} />
              </button>
            )
          ) : (
            onArchive && (
              <button 
                onClick={(e) => { e.stopPropagation(); onArchive(item.data.id); setShowActions(false); }}
                className="p-2 bg-white text-amber-500 shadow rounded-full hover:bg-amber-50 active:scale-95 transition-all"
                title="Archive"
              >
                <Archive size={18} />
              </button>
            )
          )}
          <button 
            onClick={(e) => { e.stopPropagation(); onDelete(item.data.id); setShowActions(false); }}
            className="p-2 bg-white text-rose-500 shadow rounded-full hover:bg-rose-50 active:scale-95 transition-all"
            title="Delete"
          >
            <Trash2 size={18} />
          </button>
        </div>
      )}
    </div>
  );
});

// Carousel wrapper for grouped items with same spelling
interface NotebookGroupProps {
  group: ItemGroup;
  groups: ItemGroup[]; // Full list of groups for DetailView navigation
  groupIndex: number;
  openItemId: string | null;
  setOpenItemId: (id: string | null) => void;
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: (groups: ItemGroup[], groupIndex: number, itemIndex: number) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
}

const NotebookGroup: React.FC<NotebookGroupProps> = React.memo(({
  group, groups, groupIndex, openItemId, setOpenItemId, onDelete, onSearch, onViewDetail, onArchive, onUnarchive
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const totalItems = group.items.length;
  const carouselRef = useRef<HTMLDivElement>(null);

  const touchStart = useRef<{x: number, y: number} | null>(null);
  const SWIPE_THRESHOLD = 50;
  
  // Trackpad wheel navigation for carousel
  useWheelNavigation({
    onScrollLeft: () => setCurrentIndex((prev) => (prev - 1 + totalItems) % totalItems),
    onScrollRight: () => setCurrentIndex((prev) => (prev + 1) % totalItems),
    containerRef: carouselRef,
    threshold: 80,
    enabled: totalItems > 1,
  });
  
  // Single item - no carousel needed
  if (totalItems === 1) {
    const item = group.items[0];
    return (
      <NotebookItem 
        item={item}
        isOpen={openItemId === item.data.id}
        onOpen={() => setOpenItemId(item.data.id)}
        onClose={() => setOpenItemId(null)}
        onDelete={onDelete}
        onSearch={onSearch}
        onViewDetail={() => {
          setOpenItemId(null);
          onViewDetail(groups, groupIndex, 0);
        }}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
      />
    );
  }
  
  // Multiple items - carousel mode
  const currentItem = group.items[currentIndex];
  
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    
    // Check if user is selecting text - don't interfere with text selection on iOS
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      touchStart.current = null;
      return;
    }
    
    const diffX = e.changedTouches[0].clientX - touchStart.current.x;
    const diffY = e.changedTouches[0].clientY - touchStart.current.y;
    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);
    if (absX > absY * 1.5 && absX > SWIPE_THRESHOLD) {
      if (diffX < 0) {
        setCurrentIndex((prev) => (prev + 1) % totalItems);
      } else {
        setCurrentIndex((prev) => (prev - 1 + totalItems) % totalItems);
      }
    }
    touchStart.current = null;
  };
  
  return (
    <div ref={carouselRef} className="relative" style={{ touchAction: 'pan-y' }}>
      {/* Navigation arrows for desktop */}
      {currentIndex > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); setCurrentIndex(prev => prev - 1); }}
          className="absolute -left-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-violet-600 rounded-full flex items-center justify-center shadow-md hover:bg-violet-50 transition-colors hidden md:flex"
          aria-label="Previous meaning"
        >
          <ChevronLeft size={16} />
        </button>
      )}
      {currentIndex < totalItems - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); setCurrentIndex(prev => prev + 1); }}
          className="absolute -right-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-violet-600 rounded-full flex items-center justify-center shadow-md hover:bg-violet-50 transition-colors hidden md:flex"
          aria-label="Next meaning"
        >
          <ChevronRight size={16} />
        </button>
      )}
      {/* Card */}
      <div className="w-full" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        <NotebookItem 
          item={currentItem}
          isOpen={openItemId === currentItem.data.id}
          onOpen={() => setOpenItemId(currentItem.data.id)}
          onClose={() => setOpenItemId(null)}
          onDelete={onDelete}
          onSearch={onSearch}
          onViewDetail={() => {
            setOpenItemId(null);
            onViewDetail(groups, groupIndex, currentIndex);
          }}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          totalInGroup={totalItems}
          indexInGroup={currentIndex}
        />
      </div>
      
      {/* Dot indicators */}
      <div className="flex justify-center gap-1.5 mt-2">
        {group.items.map((_, idx) => (
          <button
            key={idx}
            onClick={(e) => { e.stopPropagation(); setCurrentIndex(idx); }}
            className={`w-2 h-2 rounded-full transition-all ${
              idx === currentIndex 
                ? 'bg-violet-500 w-4' 
                : 'bg-slate-300 hover:bg-slate-400'
            }`}
          />
        ))}
      </div>
    </div>
  );
});

// Search results carousel component
interface SearchResultsCarouselProps {
  vocabs: VocabCard[];
  onSave: (vocab: VocabCard) => void;
  isVocabSaved: (vocab: VocabCard) => boolean;
  onSearch: (text: string) => void;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
}

const SearchResultsCarousel: React.FC<SearchResultsCarouselProps> = ({
  vocabs, onSave, isVocabSaved, onSearch, onSaveSentence, isSentenceSaved
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);
  const totalItems = vocabs.length;
  
  const touchStart = useRef<{x: number, y: number} | null>(null);
  const SWIPE_THRESHOLD = 50;
  
  // Navigate and pronounce - called by user interactions
  const navigateTo = useCallback((newIndex: number) => {
    setCurrentIndex(newIndex);
    const vocab = vocabs[newIndex];
    if (vocab?.word) {
      speak(vocab.word);
    }
  }, [vocabs]);
  
  // Trackpad wheel navigation
  // Left scroll (wheel right) loops, right scroll (wheel left) stops at first
  useWheelNavigation({
    onScrollLeft: () => { if (currentIndex > 0) navigateTo(currentIndex - 1); },
    onScrollRight: () => navigateTo((currentIndex + 1) % totalItems),
    containerRef: carouselRef,
    threshold: 80,
    enabled: totalItems > 1,
  });

  // Keyboard arrow navigation
  React.useEffect(() => {
    if (totalItems <= 1) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (currentIndex > 0) navigateTo(currentIndex - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateTo((currentIndex + 1) % totalItems);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalItems, currentIndex, navigateTo]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      touchStart.current = null;
      return;
    }
    
    const diffX = e.changedTouches[0].clientX - touchStart.current.x;
    const diffY = e.changedTouches[0].clientY - touchStart.current.y;
    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);
    if (absX > absY * 1.5 && absX > SWIPE_THRESHOLD) {
      if (diffX < 0) {
        // Left swipe -> next item, loops forever
        navigateTo((currentIndex + 1) % totalItems);
      } else {
        // Right swipe -> previous item, stops at first
        if (currentIndex > 0) {
          navigateTo(currentIndex - 1);
        }
      }
    }
    touchStart.current = null;
  };
  
  const currentVocab = vocabs[currentIndex];
  
  return (
    <div className="px-3 pt-3 pb-2">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Wand2 size={14} className="text-violet-500" />
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Search Results</span>
        </div>
        {totalItems > 1 && (
          <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2.5 py-1 rounded-full border border-violet-100">
            {currentIndex + 1}/{totalItems}
          </span>
        )}
      </div>
      
      <div ref={carouselRef} className="relative max-w-screen-md mx-auto" style={{ touchAction: 'pan-y' }}>
        {/* Navigation arrows for desktop */}
        {/* Previous arrow - only shows when not at first item */}
        {totalItems > 1 && currentIndex > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); navigateTo(currentIndex - 1); }}
            className="absolute -left-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-violet-600 rounded-full flex items-center justify-center shadow-md hover:bg-violet-50 transition-colors hidden md:flex"
            aria-label="Previous meaning"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        {/* Next arrow - always shows (loops forever) */}
        {totalItems > 1 && (
          <button
            onClick={(e) => { e.stopPropagation(); navigateTo((currentIndex + 1) % totalItems); }}
            className="absolute -right-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-violet-600 rounded-full flex items-center justify-center shadow-md hover:bg-violet-50 transition-colors hidden md:flex"
            aria-label="Next meaning"
          >
            <ChevronRight size={16} />
          </button>
        )}
        
        <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          <VocabCardDisplay
            data={currentVocab}
            isSaved={isVocabSaved(currentVocab)}
            onSave={() => onSave(currentVocab)}
            showSave={true}
            onSearch={onSearch}
            scrollable={false}
            className="!h-auto !overflow-visible border-violet-200 shadow-sm hover:shadow-md transition-shadow bg-white"
            onSaveSentence={onSaveSentence}
            isSentenceSaved={isSentenceSaved}
          />
        </div>
        
        {/* Dot indicators */}
        {totalItems > 1 && (
          <div className="flex justify-center gap-1.5 mt-3">
            {vocabs.map((_, idx) => (
              <button
                key={idx}
                onClick={(e) => { e.stopPropagation(); navigateTo(idx); }}
                className={`w-2 h-2 rounded-full transition-all ${
                  idx === currentIndex 
                    ? 'bg-violet-500 w-4' 
                    : 'bg-slate-300 hover:bg-slate-400'
                }`}
              />
            ))}
          </div>
        )}
      </div>
      
      <div className="border-b border-slate-200 mt-4 mb-2" />
    </div>
  );
};

interface NotebookProps {
  items: StoredItem[];
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: (groups: ItemGroup[], groupIndex: number, itemIndex: number) => void;
  user: AppUser | null;
  onSignIn: () => void;
  onSignOut: () => void;
  syncStatus?: SyncStatus;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onForceSync?: () => void;
  isOnline?: boolean;
  onBulkRefresh?: () => void;
  bulkRefreshProgress?: { current: number; total: number; isRunning: boolean } | null;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  onSave?: (item: StoredItem) => void;
  onUpdateStoredItem?: (item: StoredItem) => void;
  onCompare?: (words: string[]) => void;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
  hasOverlay?: boolean;
  projects?: ProjectInfo[];
  activeProject?: string | null;
  onSetActiveProject?: (id: string | null) => void;
  onProjectsChanged?: (projects: ProjectInfo[]) => void;
  allItems?: StoredItem[];
  onBatchImport?: (words: string[], project?: string) => void;
  batchImportProgress?: { current: number; total: number; skipped: number; failed: number; saved: number; isRunning: boolean } | null;
}

export const NotebookView: React.FC<NotebookProps> = React.memo(({
    items, onDelete, onSearch, onViewDetail,
    user, onSignIn, onSignOut, syncStatus, onScroll, onForceSync, isOnline = true,
    onBulkRefresh, bulkRefreshProgress, onArchive, onUnarchive, onSave, onUpdateStoredItem, onCompare,
    onSaveSentence, isSentenceSaved, hasOverlay,
    projects = [], activeProject, onSetActiveProject, onProjectsChanged, allItems,
    onBatchImport, batchImportProgress
}) => {
  const [sortMode, setSortMode] = useState<'familiarity' | 'alphabetical'>('familiarity');
  const [filterMode, setFilterMode] = useState<'all' | 'vocab' | 'phrase'>('vocab'); // Default to vocab only
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const lastScrollY = useRef(0);
  
  // AI Search state
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchGenerationIdRef = useRef(0); // Incremented on each search to cancel stale image updates
  
  // Text Analyzer modal state
  const [showTextAnalyzer, setShowTextAnalyzer] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);

  // Project state
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [showProjectManager, setShowProjectManager] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  // Close project dropdown on outside click
  useEffect(() => {
    if (!showProjectDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setShowProjectDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showProjectDropdown]);

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

    // Increment generation ID to cancel stale image updates from previous searches
    const currentGenId = ++searchGenerationIdRef.current;

    try {
      const result = await analyzeInput(query.trim());
      if (searchGenerationIdRef.current !== currentGenId) return; // Superseded by new search
      setSearchResults(result);

      // Auto-pronounce the word once when results arrive
      if (result.vocabs && result.vocabs.length > 0) {
        const wordToSpeak = result.vocabs[0].word || query.trim();
        setTimeout(() => speak(wordToSpeak), 100);

        // Generate images asynchronously for each vocab (don't block UI)
        result.vocabs.forEach(async (vocab, index) => {
          if (vocab.imagePrompt && !vocab.imageUrl) {
            try {
              const imageData = await generateIllustration(vocab.imagePrompt, '16:9');
              // Skip update if a newer search has started
              if (searchGenerationIdRef.current !== currentGenId) return;
              if (imageData) {
                setSearchResults(prev => {
                  if (!prev || !prev.vocabs) return prev;
                  const updatedVocabs = [...prev.vocabs];
                  if (updatedVocabs[index]) {
                    updatedVocabs[index] = { ...updatedVocabs[index], imageUrl: imageData };
                  }
                  return { ...prev, vocabs: updatedVocabs };
                });
              }
            } catch (imgErr) {
              warn('Image generation failed for vocab:', vocab.word, imgErr);
            }
          }
        });
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

  // Listen for notebook-search events from App.tsx
  useEffect(() => {
    const handleNotebookSearch = (e: CustomEvent<{ query: string; forceAI: boolean; autoAIIfNoMatch?: boolean }>) => {
      const { query, forceAI, autoAIIfNoMatch } = e.detail;
      setLocalSearchQuery(query);
      if (forceAI && query.trim()) {
        performAISearch(query);
      } else if (autoAIIfNoMatch && query.trim()) {
        // Check if any saved item has an exact word match
        const queryLower = query.toLowerCase().trim();
        const hasExactMatch = items.some(item => {
          const title = item.type === 'phrase'
            ? (item.data as SearchResult).query
            : (item.data as VocabCard).word;
          return (title || '').toLowerCase().trim() === queryLower;
        });

        if (!hasExactMatch) {
          performAISearch(query);
        }
      }
    };

    window.addEventListener('notebook-search', handleNotebookSearch as EventListener);
    return () => window.removeEventListener('notebook-search', handleNotebookSearch as EventListener);
  }, [performAISearch, items]);

  // Escape key to exit compare mode
  useEffect(() => {
    if (!compareMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCompareMode(false);
        setSelectedForCompare([]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [compareMode]);

  // Global Escape to clear search (works even when input is not focused)
  useEffect(() => {
    if (hasOverlay) return; // Don't clear search when an overlay (DetailView, modal) is open
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (localSearchQuery || searchResults) {
        e.preventDefault();
        e.stopPropagation();
        setLocalSearchQuery('');
        setSearchResults(null);
        setSearchError(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [localSearchQuery, searchResults, hasOverlay]);

  // Clear search results when query is cleared
  useEffect(() => {
    if (!localSearchQuery.trim()) {
      setSearchResults(null);
      setSearchError(null);
    }
  }, [localSearchQuery]);

  // Save a vocab from search results
  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    if (!onSave) return;
    
    onSave({
      data: vocab,
      type: 'vocab',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(vocab.id, 'vocab')
    });
  }, [onSave]);

  // Check if a vocab is already saved
  const isVocabSaved = useCallback((vocab: VocabCard) => {
    const vocabWord = (vocab.word || '').toLowerCase().trim();
    return items.some(i => {
      if (i.type !== 'vocab') return false;
      const savedWord = ((i.data as VocabCard).word || '').toLowerCase().trim();
      const savedSense = (i.data as VocabCard).sense || '';
      return savedWord === vocabWord && savedSense === vocab.sense;
    });
  }, [items]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;
    
    // Top buffer zone
    if (currentScrollY < 50) {
      if (!showHeader) setShowHeader(true);
    } else if (Math.abs(currentScrollY - lastScrollY.current) > 10) {
      setShowHeader(currentScrollY < lastScrollY.current);
    }
    
    lastScrollY.current = currentScrollY;
    onScroll?.(e);
  };
  
  // Memoize Fuse index separately - only rebuild when items change, not on every keystroke
  const fuseIndex = React.useMemo(() => {
    return new Fuse(items, {
      keys: [
        'data.word',
        'data.query',
        'data.chinese',
        'data.translation'
      ],
      threshold: 0.3,
      ignoreLocation: true
    });
  }, [items]);

  const { displayItems, groupedItems, archivedItems, archivedGroups, dueForReviewGroups } = React.useMemo(() => {
    // 1. Fuzzy Search
    let processedItems = items;
    
    if (localSearchQuery.trim()) {
      const fuseResults = fuseIndex.search(localSearchQuery).map(result => result.item);
      
      // Chinese input: Fuse.js Bitap algorithm doesn't work well with CJK characters.
      // Fall back to substring matching against chinese/translation fields.
      const containsChinese = /[\u4e00-\u9fff]/.test(localSearchQuery);
      if (containsChinese) {
        const query = localSearchQuery.trim();
        const fuseIds = new Set(fuseResults.map(i => i.data.id));
        const chineseMatches = items.filter(item => {
          if (fuseIds.has(item.data.id)) return false; // Already in Fuse results
          const chinese = (item.data as any).chinese || '';
          const translation = (item.data as any).translation || '';
          return chinese.includes(query) || translation.includes(query);
        });
        processedItems = [...fuseResults, ...chineseMatches];
      } else {
        processedItems = fuseResults;
      }

      // Expand fuzzy results to include all sibling items (same word, different senses)
      const matchedTitles = new Set<string>();
      processedItems.forEach(item => {
        const title = item.type === 'phrase'
          ? (item.data as any).query?.toLowerCase().trim()
          : (item.data as any).word?.toLowerCase().trim();
        if (title) matchedTitles.add(title);
      });

      const matchedIds = new Set(processedItems.map(i => i.data.id));
      const siblings = items.filter(item => {
        if (matchedIds.has(item.data.id)) return false;
        const title = item.type === 'phrase'
          ? (item.data as any).query?.toLowerCase().trim()
          : (item.data as any).word?.toLowerCase().trim();
        return title ? matchedTitles.has(title) : false;
      });

      processedItems = [...processedItems, ...siblings];
    }

    // Separate active and archived items
    const activeFiltered = processedItems
      .filter(i => {
        const isValid = i && i.data && i.data.id && !i.isDeleted && !i.isArchived;
        if (!isValid) return false;
        
        if (filterMode === 'vocab') return i.type === 'vocab';
        if (filterMode === 'phrase') return i.type === 'phrase';
        
        return true;
      })
      .sort((a, b) => {
        if (sortMode === 'alphabetical') {
          const titleA = a.type === 'phrase' ? (a.data as any).query : (a.data as any).word;
          const titleB = b.type === 'phrase' ? (b.data as any).query : (b.data as any).word;
          return (titleA || '').localeCompare(titleB || '');
        }

        // Sort by Priority (Due/Overdue first, then by Strength)
        const now = Date.now();
        const dueA = a.srs?.nextReview || 0;
        const dueB = b.srs?.nextReview || 0;
        const isDueA = dueA <= now;
        const isDueB = dueB <= now;

        // 1. Due items always come before non-due items
        if (isDueA !== isDueB) {
          return isDueA ? -1 : 1;
        }

        // 2. If both are Due: Sort by Strength ASC (weakest first), then by Overdue amount
        if (isDueA && isDueB) {
            const strengthA = a.srs?.memoryStrength || 0;
            const strengthB = b.srs?.memoryStrength || 0;
            if (strengthA !== strengthB) return strengthA - strengthB;
            return dueA - dueB; // Oldest due date first
        }

        // 3. If neither is Due (Future): Sort by Next Review Date ASC (soonest first)
        return dueA - dueB;
      });
    
    // Archived items
    const archivedFiltered = processedItems
      .filter(i => {
        const isValid = i && i.data && i.data.id && !i.isDeleted && i.isArchived;
        if (!isValid) return false;
        
        if (filterMode === 'vocab') return i.type === 'vocab';
        if (filterMode === 'phrase') return i.type === 'phrase';
        
        return true;
      })
      .sort((a, b) => {
        const titleA = a.type === 'phrase' ? (a.data as any).query : (a.data as any).word;
        const titleB = b.type === 'phrase' ? (b.data as any).query : (b.data as any).word;
        return (titleA || '').localeCompare(titleB || '');
      });
    
    // Helper to group items by title
    const groupByTitle = (itemList: StoredItem[]): ItemGroup[] => {
      const groupMap = new Map<string, StoredItem[]>();
      itemList.forEach(item => {
        const title = item.type === 'phrase' 
          ? (item.data as any).query?.toLowerCase().trim()
          : (item.data as any).word?.toLowerCase().trim();
        
        if (!title) return;
        
        if (!groupMap.has(title)) {
          groupMap.set(title, []);
        }
        groupMap.get(title)!.push(item);
      });
      
      const groups: ItemGroup[] = [];
      const seenTitles = new Set<string>();
      
      itemList.forEach(item => {
        const title = item.type === 'phrase' 
          ? (item.data as any).query?.toLowerCase().trim()
          : (item.data as any).word?.toLowerCase().trim();
        
        if (!title || seenTitles.has(title)) return;
        seenTitles.add(title);
        
        const groupItems = groupMap.get(title) || [];
        groups.push({
          title: title,
          items: groupItems
        });
      });
      
      return groups;
    };
    
    // "Due for Review" backfill: when searching, show all due items
    // so user can review while waiting for AI search results
    let dueForReview: ItemGroup[] = [];
    if (localSearchQuery.trim()) {
      const now = Date.now();
      const fuzzyIds = new Set(activeFiltered.map(i => i.data.id));

      const dueItems = items
        .filter(i => {
          if (!i || !i.data || !i.data.id || i.isDeleted || i.isArchived) return false;
          if (fuzzyIds.has(i.data.id)) return false; // Already shown in fuzzy results
          if ((i.srs?.nextReview || 0) > now) return false; // Not due yet
          if (filterMode === 'vocab' && i.type !== 'vocab') return false;
          if (filterMode === 'phrase' && i.type !== 'phrase') return false;
          return true;
        })
        .sort((a, b) => {
          // Weakest memory first, then oldest due date
          const strengthA = a.srs?.memoryStrength || 0;
          const strengthB = b.srs?.memoryStrength || 0;
          if (strengthA !== strengthB) return strengthA - strengthB;
          return (a.srs?.nextReview || 0) - (b.srs?.nextReview || 0);
        });

      dueForReview = groupByTitle(dueItems);
    }

    return { 
      displayItems: activeFiltered, 
      groupedItems: groupByTitle(activeFiltered),
      archivedItems: archivedFiltered,
      archivedGroups: groupByTitle(archivedFiltered),
      dueForReviewGroups: dueForReview
    };
  }, [items, sortMode, filterMode, localSearchQuery, fuseIndex]);

  // Flatten groups into a single list for virtualization
  type VirtualRow =
    | { type: 'group'; group: ItemGroup; groups: ItemGroup[]; groupIndex: number; section: 'main' | 'due' | 'archived' }
    | { type: 'due-header'; count: number }
    | { type: 'archived-toggle'; count: number }
    | { type: 'compare-banner' };

  const virtualRows = useMemo((): VirtualRow[] => {
    const rows: VirtualRow[] = [];

    // Compare mode banner
    if (compareMode) {
      rows.push({ type: 'compare-banner' });
    }

    // Main items
    groupedItems.forEach((group, index) => {
      rows.push({ type: 'group', group, groups: groupedItems, groupIndex: index, section: 'main' });
    });

    // Due for review section
    if (dueForReviewGroups.length > 0) {
      rows.push({ type: 'due-header', count: dueForReviewGroups.length });
      dueForReviewGroups.forEach((group, index) => {
        rows.push({ type: 'group', group, groups: dueForReviewGroups, groupIndex: index, section: 'due' });
      });
    }

    // Archived toggle
    if (archivedItems.length > 0) {
      rows.push({ type: 'archived-toggle', count: archivedItems.length });
      if (showArchived) {
        archivedGroups.forEach((group, index) => {
          rows.push({ type: 'group', group, groups: archivedGroups, groupIndex: index, section: 'archived' });
        });
      }
    }

    return rows;
  }, [groupedItems, dueForReviewGroups, archivedItems.length, archivedGroups, showArchived, compareMode]);

  const renderVirtualRow = useCallback((index: number) => {
    const row = virtualRows[index];
    if (!row) return null;

    if (row.type === 'compare-banner') {
      return (
        <div className="px-3 pt-3">
          <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 animate-in slide-in-from-top-2 duration-200">
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
            onClick={() => setShowArchived(!showArchived)}
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
    const { group, groups, groupIndex, section } = row;
    const keyPrefix = section === 'due' ? 'due-' : section === 'archived' ? 'archived-' : '';

    if (compareMode && section === 'main') {
      const firstItem = group.items[0];
      const displayWord = firstItem
        ? (firstItem.type === 'phrase'
            ? (firstItem.data as SearchResult).query
            : (firstItem.data as VocabCard).word) || group.title
        : group.title;
      const isSelected = selectedForCompare.includes(displayWord);
      const canSelect = selectedForCompare.length < 3 || isSelected;

      return (
        <div className="px-3 py-1.5">
          <div
            className={`relative cursor-pointer transition-all ${isSelected ? 'ring-2 ring-indigo-400 rounded-2xl' : ''}`}
            onClick={() => {
              if (isSelected) {
                setSelectedForCompare(prev => prev.filter(w => w !== displayWord));
              } else if (canSelect) {
                setSelectedForCompare(prev => [...prev, displayWord]);
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
            <div className="pointer-events-none">
              <NotebookGroup
                group={group}
                groups={groups}
                groupIndex={groupIndex}
                openItemId={null}
                setOpenItemId={() => {}}
                onDelete={() => {}}
                onSearch={() => {}}
                onViewDetail={() => {}}
              />
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="px-3 py-1.5">
        <NotebookGroup
          key={`${keyPrefix}${group.title}`}
          group={group}
          groups={groups}
          groupIndex={groupIndex}
          openItemId={openItemId}
          setOpenItemId={setOpenItemId}
          onDelete={onDelete}
          onSearch={onSearch}
          onViewDetail={onViewDetail}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
        />
      </div>
    );
  }, [virtualRows, compareMode, selectedForCompare, openItemId, onDelete, onSearch, onViewDetail, onArchive, onUnarchive, showArchived]);

  const { reviewedToday, dueCount } = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();
    let reviewed = 0;
    let due = 0;
    for (const item of items) {
      if (item.isDeleted || item.isArchived || !item.srs) continue;
      if (item.srs.lastReviewDate >= todayTs) reviewed++;
      if (item.srs.nextReview <= now) due++;
    }
    return { reviewedToday: reviewed, dueCount: due };
  }, [items]);

  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);

  if (displayItems.length === 0 && !localSearchQuery) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50">
        <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
          <BookOpen size={32} className="text-indigo-300" />
        </div>
        <h3 className="text-xl font-bold text-slate-700 mb-2">Your notebook is empty</h3>
        <p className="text-sm mb-8 max-w-xs mx-auto">Search for a word or phrase to get started.</p>

        <div className="w-full max-w-sm">
          <form onSubmit={(e) => { e.preventDefault(); if (localSearchQuery.trim()) handleSearch(localSearchQuery.trim()); }} className="relative">
            <input
              ref={searchInputRef}
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
      ref={setScrollParent}
      className="h-full overflow-y-auto overflow-x-hidden bg-slate-50"
      onScroll={handleScroll}
    >
      {/* Header */}
      <div className={`sticky top-0 z-10 bg-slate-50/90 backdrop-blur-md border-b border-slate-200/50 transition-transform duration-300 ${showHeader ? 'translate-y-0' : '-translate-y-full'}`}>
        <div className="px-6 py-4 flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Notebook</h2>
            <p className="text-xs text-slate-500 font-medium">{groupedItems.length} saved · {reviewedToday} reviewed today · {dueCount} due</p>
          </div>
          <div className="flex items-center gap-1 bg-white rounded-full p-1 border border-slate-100 shadow-sm flex-nowrap shrink-0">
            {/* Text Analyzer button */}
            {isOnline && (
              <button
                onClick={() => setShowTextAnalyzer(true)}
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full text-violet-400 hover:text-violet-600 hover:bg-violet-50 transition-colors"
                title="Text Analyzer — Extract vocabulary from pasted text"
              >
                <ScanText size={16} />
              </button>
            )}
            {/* Batch Import button */}
            {isOnline && (
              <button
                onClick={() => setShowBatchImport(true)}
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                title="Batch Import — Paste a word list to analyze and save in bulk"
              >
                <ListPlus size={16} />
              </button>
            )}
            {/* Compare mode toggle */}
            {onCompare && isOnline && (
              <button
                onClick={() => {
                  setCompareMode(prev => !prev);
                  setSelectedForCompare([]);
                }}
                className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-full transition-colors ${
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
              onClick={() => setFilterMode(prev => {
                if (prev === 'all') return 'vocab';
                if (prev === 'vocab') return 'phrase';
                return 'all';
              })}
              className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-full hover:bg-slate-50 transition-colors ${filterMode !== 'all' ? 'text-indigo-600 bg-indigo-50' : 'text-slate-400'}`}
              title={`Filter: ${filterMode === 'all' ? 'All Items' : filterMode === 'vocab' ? 'Vocabulary Only' : 'Phrases Only'}`}
            >
              {filterMode === 'all' && <Filter size={16} />}
              {filterMode === 'vocab' && <Type size={16} />}
              {filterMode === 'phrase' && <Layers size={16} />}
            </button>
            <button
              onClick={() => setSortMode(prev => prev === 'familiarity' ? 'alphabetical' : 'familiarity')}
              className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full hover:bg-slate-50 text-slate-400 hover:text-indigo-600 transition-colors"
              title={sortMode === 'familiarity' ? 'Sort: Review Priority' : 'Sort: A-Z'}
            >
              {sortMode === 'familiarity' ? <Sparkles size={16} /> : <ArrowDownAZ size={16} />}
            </button>
            {/* Project filter */}
            {onSetActiveProject && (
              <div className="relative shrink-0" ref={projectDropdownRef}>
                <button
                  onClick={() => projects.length > 0 ? setShowProjectDropdown(prev => !prev) : setShowProjectManager(true)}
                  className={`h-8 shrink-0 flex items-center gap-1 rounded-full px-2 transition-colors ${
                    activeProject
                      ? 'text-indigo-600 bg-indigo-50'
                      : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'
                  }`}
                  title={activeProject ? `Project: ${projects.find(p => p.id === activeProject)?.name}` : 'Projects'}
                >
                  <FolderOpen size={14} />
                  {activeProject && (
                    <span className="text-[11px] font-semibold max-w-[60px] truncate">
                      {projects.find(p => p.id === activeProject)?.name}
                    </span>
                  )}
                </button>
                {showProjectDropdown && (
                  <div className="absolute right-0 top-full mt-1 w-48 bg-white rounded-xl shadow-lg border border-slate-200 py-1 z-50 animate-in fade-in zoom-in-95 duration-150">
                    <button
                      onClick={() => { onSetActiveProject(null); setShowProjectDropdown(false); }}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                        !activeProject ? 'text-indigo-600 bg-indigo-50 font-semibold' : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      All Projects
                    </button>
                    <div className="h-px bg-slate-100 my-1" />
                    {projects.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { onSetActiveProject(p.id); setShowProjectDropdown(false); }}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                          activeProject === p.id ? 'text-indigo-600 bg-indigo-50 font-semibold' : 'text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                    <div className="h-px bg-slate-100 my-1" />
                    <button
                      onClick={() => { setShowProjectDropdown(false); setShowProjectManager(true); }}
                      className="w-full text-left px-3 py-2 text-sm text-slate-500 hover:bg-slate-50 flex items-center gap-2"
                    >
                      <Settings size={12} />
                      Manage Projects
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="h-4 w-[1px] bg-slate-200 mx-1 shrink-0"></div>
            {/* Refresh All Button */}
            {onBulkRefresh && isOnline && (
              <button 
                onClick={onBulkRefresh} 
                disabled={bulkRefreshProgress?.isRunning}
                className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-full ${bulkRefreshProgress?.isRunning ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-violet-50'}`}
                title="Refresh All Items (re-search with latest AI)"
              >
                {bulkRefreshProgress?.isRunning ? (
                  <Loader2 className="animate-spin text-violet-500" size={14} />
                ) : (
                  <RotateCcw className="text-violet-400 hover:text-violet-600 transition-colors" size={14} />
                )}
              </button>
            )}
            {!isOnline ? (
              <div className="flex items-center gap-1 text-amber-500 px-1 shrink-0" title="Offline">
                <WifiOff size={14} />
              </div>
            ) : (
              <button 
                onClick={onForceSync} 
                disabled={syncStatus === 'syncing'}
                className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-full ${syncStatus === 'syncing' ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-slate-50'}`}
                title="Force Sync"
              >
                {syncStatus === 'syncing' ? (
                  <Loader2 className="animate-spin text-indigo-500" size={14} />
                ) : (
                  <RefreshCw className="text-slate-400 hover:text-indigo-500 transition-colors" size={14} />
                )}
              </button>
            )}
            {user && (
              <>
                <div className="h-4 w-[1px] bg-slate-200 mx-1 shrink-0"></div>
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
              ref={searchInputRef}
              type="text"
              value={localSearchQuery}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={isRecording ? "Listening..." : "Search or look up new word"}
              className="w-full pl-10 pr-20 py-2.5 bg-white border border-slate-200 rounded-xl text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-sm"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {/* Voice recording button */}
              {!localSearchQuery && !isSearching && !isTranscribing && (
                <button 
                  onClick={toggleRecording}
                  className={`p-1.5 rounded-lg transition-all ${
                    isRecording 
                      ? 'text-rose-500 bg-rose-50 animate-pulse' 
                      : 'text-slate-400 hover:text-violet-600 hover:bg-violet-50'
                  }`}
                  title={isRecording ? 'Stop recording' : 'Voice search'}
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
                  className="text-violet-500 hover:text-violet-700 p-1.5 rounded-lg hover:bg-violet-50 transition-colors"
                  title="Search with AI (Enter)"
                  disabled={!isOnline}
                >
                  <Wand2 size={16} />
                </button>
              )}
              {isSearching && (
                <Loader2 className="animate-spin text-violet-500" size={16} />
              )}
              {localSearchQuery && !isSearching && !isTranscribing && (
                <button 
                  onClick={() => {
                    setLocalSearchQuery('');
                    setSearchResults(null);
                    setSearchError(null);
                  }}
                  className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition-colors"
                  title="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bulk Refresh Progress Banner */}
      {bulkRefreshProgress?.isRunning && (
        <div className="sticky top-[72px] z-[9] bg-violet-500 text-white px-4 py-3 shadow-md">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Loader2 className="animate-spin" size={18} />
              <div>
                <p className="font-medium text-sm">Refreshing all items...</p>
                <p className="text-xs text-violet-200">
                  {bulkRefreshProgress.current} / {bulkRefreshProgress.total} words processed
                </p>
              </div>
            </div>
            <div className="w-24 h-2 bg-violet-400 rounded-full overflow-hidden">
              <div
                className="h-full bg-white transition-all duration-300"
                style={{ width: `${(bulkRefreshProgress.current / bulkRefreshProgress.total) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}

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
        />
      )}

      <div className="w-full max-w-screen-md mx-auto pb-[calc(5rem+env(safe-area-inset-bottom))]">
        {scrollParent && (
          <Virtuoso
            customScrollParent={scrollParent}
            totalCount={virtualRows.length}
            overscan={400}
            itemContent={renderVirtualRow}
          />
        )}
      </div>

      {/* Text Analyzer Modal */}
      {onSave && (
        <TextAnalyzer
          isOpen={showTextAnalyzer}
          onClose={() => setShowTextAnalyzer(false)}
          onSave={onSave}
          onUpdateStoredItem={onUpdateStoredItem}
          savedItems={items}
          isOnline={isOnline}
        />
      )}

      {/* Batch Import Modal */}
      {onBatchImport && (
        <BatchImport
          isOpen={showBatchImport}
          onClose={() => setShowBatchImport(false)}
          onSubmit={onBatchImport}
          projects={projects}
          activeProject={activeProject ?? undefined}
        />
      )}

      {/* Project Manager Modal */}
      {onProjectsChanged && (
        <ProjectManager
          isOpen={showProjectManager}
          onClose={() => setShowProjectManager(false)}
          onProjectsChanged={onProjectsChanged}
          allItems={allItems || items}
        />
      )}

      {/* Compare floating action button */}
      {compareMode && selectedForCompare.length >= 2 && onCompare && (
        <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-0 right-0 flex justify-center z-20 pointer-events-none">
          <button
            onClick={() => {
              onCompare(selectedForCompare);
              setCompareMode(false);
              setSelectedForCompare([]);
            }}
            className="pointer-events-auto px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-full shadow-lg hover:shadow-xl transition-all flex items-center gap-2 animate-in zoom-in-95 duration-200"
          >
            <Scale size={18} />
            Compare {selectedForCompare.length} Words
          </button>
        </div>
      )}
    </div>
  );
});
