import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Fuse from 'fuse.js';
import { StoredItem, SyncStatus, AppUser, ItemGroup, SearchResult, VocabCard, getItemTitle, getItemSpelling, getItemTranslation, getItemPronunciation, getItemSense, isPhraseItem, isVocabItem } from '../types';
import { Trash2, BookOpen, Layers, Loader2, RefreshCw, Type, ArrowDownAZ, Sparkles, Filter, WifiOff, ChevronLeft, ChevronRight, RotateCcw, Archive, ArchiveRestore, ChevronDown, ChevronUp, Search, X, Clipboard, ArrowRight, AlertCircle, Bookmark } from 'lucide-react';
import { Button } from '../components/Button';
import { UserMenu } from '../components/UserMenu';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { VocabCardDisplay } from '../components/VocabCard';
import { useKeyboardNavigation, useWheelNavigation } from '../hooks';
import { analyzeInput, generateIllustration } from '../services/geminiService';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { speak } from '../services/speech';
import { warn } from '../services/logger';

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

const NotebookItem: React.FC<NotebookItemProps> = ({
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

  const handleClick = () => {
    if (showActions) {
      setShowActions(false);
      return;
    }
    onViewDetail();
  };

  const isPhrase = isPhraseItem(item);
  const title = getItemTitle(item);
  const subtitle = getItemTranslation(item);
  const ipa = getItemPronunciation(item);
  const examples = isVocabItem(item) ? item.data.examples : [];
  const history = isVocabItem(item) ? item.data.history : null;
  const sense = getItemSense(item);

  const nextReview = item.srs.nextReview;
  const isDue = nextReview <= Date.now();
  const intervalDays = Math.round(item.srs.interval / (24 * 60));

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
                  "{examples[0]}"
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
};

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

const NotebookGroup: React.FC<NotebookGroupProps> = ({
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
  onSave: (item: StoredItem) => void;
  onUpdateStoredItem: (item: StoredItem) => void;
}

export const NotebookView: React.FC<NotebookProps> = ({ 
    items, onDelete, onSearch, onViewDetail, 
    user, onSignIn, onSignOut, syncStatus, onScroll, onForceSync, isOnline = true,
    onBulkRefresh, bulkRefreshProgress, onArchive, onUnarchive, onSave, onUpdateStoredItem
}) => {
  // Persist notebook UI state to localStorage for iOS PWA resume
  const [sortMode, setSortMode] = useState<'familiarity' | 'alphabetical'>(() => {
    const saved = localStorage.getItem('notebook_sort_mode');
    return (saved === 'alphabetical' || saved === 'familiarity') ? saved : 'familiarity';
  });
  const [filterMode, setFilterMode] = useState<'all' | 'vocab' | 'phrase'>(() => {
    const saved = localStorage.getItem('notebook_filter_mode');
    return (saved === 'all' || saved === 'vocab' || saved === 'phrase') ? saved : 'vocab';
  });
  const [localSearchQuery, setLocalSearchQuery] = useState(() => {
    return localStorage.getItem('notebook_search_query') || '';
  });
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const [showArchived, setShowArchived] = useState(() => {
    return localStorage.getItem('notebook_show_archived') === 'true';
  });
  const lastScrollY = useRef(0);
  
  // Persist state changes
  useEffect(() => {
    localStorage.setItem('notebook_sort_mode', sortMode);
  }, [sortMode]);
  
  useEffect(() => {
    localStorage.setItem('notebook_filter_mode', filterMode);
  }, [filterMode]);
  
  useEffect(() => {
    localStorage.setItem('notebook_search_query', localSearchQuery);
  }, [localSearchQuery]);
  
  useEffect(() => {
    localStorage.setItem('notebook_show_archived', showArchived.toString());
  }, [showArchived]);
  
  // AI Search state
  const [aiSearchResult, setAiSearchResult] = useState<SearchResult | null>(null);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiSearchError, setAiSearchError] = useState<string | null>(null);
  const [vocabIndex, setVocabIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const aiSearchCarouselRef = useRef<HTMLDivElement>(null);
  const isMounted = useRef(true);
  const searchRequestId = useRef(0);

  // Calculate total vocabs for keyboard/wheel navigation
  const totalAIVocabs = aiSearchResult?.vocabs?.length || 0;

  // Keyboard navigation for AI search results carousel
  useKeyboardNavigation({
    onArrowLeft: () => {
      if (totalAIVocabs > 1 && vocabIndex > 0) {
        setVocabIndex(prev => prev - 1);
      }
    },
    onArrowRight: () => {
      if (totalAIVocabs > 1 && vocabIndex < totalAIVocabs - 1) {
        setVocabIndex(prev => prev + 1);
      }
    },
    onEnter: () => {
      // Save current vocab when pressing Enter
      const currentVocab = aiSearchResult?.vocabs?.[vocabIndex];
      if (currentVocab) {
        const isVocabSaved = items.some(i => 
          i.data.id === currentVocab.id || 
          (getItemTitle(i).toLowerCase().trim() === (currentVocab.word || '').toLowerCase().trim() && 
           i.type === 'vocab' && 
           (i.data as VocabCard).sense === currentVocab.sense)
        );
        if (!isVocabSaved && currentVocab.id) {
          onSave({
            data: currentVocab,
            type: 'vocab',
            savedAt: Date.now(),
            srs: SRSAlgorithm.createNew(currentVocab.id, 'vocab')
          });
        }
      }
    },
    enabled: aiSearchResult !== null && !aiSearchLoading,
  });

  // Trackpad wheel navigation for AI search results carousel
  useWheelNavigation({
    onScrollLeft: () => {
      if (totalAIVocabs > 1 && vocabIndex > 0) {
        setVocabIndex(prev => prev - 1);
      }
    },
    onScrollRight: () => {
      if (totalAIVocabs > 1 && vocabIndex < totalAIVocabs - 1) {
        setVocabIndex(prev => prev + 1);
      }
    },
    containerRef: aiSearchCarouselRef,
    threshold: 80,
    enabled: totalAIVocabs > 1,
  });

  // Cleanup on unmount
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Listen for external search requests (from App.tsx)
  useEffect(() => {
    const handleExternalSearch = (e: CustomEvent<{ query: string; forceAI: boolean }>) => {
      const { query, forceAI } = e.detail;
      setLocalSearchQuery(query);
      if (forceAI) {
        performAISearch(query);
      }
    };

    window.addEventListener('notebook-search', handleExternalSearch as EventListener);
    return () => window.removeEventListener('notebook-search', handleExternalSearch as EventListener);
  }, []);

  // Clear AI results when search query is cleared
  useEffect(() => {
    if (!localSearchQuery.trim()) {
      setAiSearchResult(null);
      setAiSearchError(null);
      setVocabIndex(0);
    }
  }, [localSearchQuery]);

  // Auto-pronounce when AI search result loads or when swiping between meanings
  useEffect(() => {
    if (aiSearchResult && aiSearchResult.vocabs && aiSearchResult.vocabs.length > 0) {
      const currentVocab = aiSearchResult.vocabs[vocabIndex];
      if (currentVocab?.word) {
        // Small delay to ensure UI has updated
        const timer = setTimeout(() => {
          speak(currentVocab.word);
        }, 100);
        return () => clearTimeout(timer);
      }
    }
  }, [aiSearchResult, vocabIndex]);

  const performAISearch = async (text: string) => {
    if (!text.trim()) return;
    
    // Check if offline
    if (!navigator.onLine) {
      setAiSearchError("You're offline. AI search only works when connected.");
      return;
    }

    const currentSearchId = ++searchRequestId.current;
    setAiSearchLoading(true);
    setAiSearchError(null);
    setAiSearchResult(null);
    setVocabIndex(0);

    try {
      const rawData = await analyzeInput(text);
      if (!isMounted.current || currentSearchId !== searchRequestId.current) return;

      setAiSearchResult(rawData);
      setAiSearchLoading(false);

      // Generate images in background
      if (rawData.visualKeyword) {
        generateIllustration(rawData.visualKeyword, '16:9').then(img => {
          if (!isMounted.current || currentSearchId !== searchRequestId.current) return;
          if (img) {
            setAiSearchResult(prev => prev ? { ...prev, imageUrl: img } : null);
          }
        });
      }

      // Generate vocab images
      for (const vocab of rawData.vocabs || []) {
        if (!isMounted.current || currentSearchId !== searchRequestId.current) return;
        if (vocab.imagePrompt) {
          generateIllustration(vocab.imagePrompt, '16:9').then(img => {
            if (!isMounted.current || currentSearchId !== searchRequestId.current) return;
            if (img) {
              setAiSearchResult(prev => {
                if (!prev) return null;
                const newVocabs = (prev.vocabs || []).map(v =>
                  v.id === vocab.id ? { ...v, imageUrl: img } : v
                );
                return { ...prev, vocabs: newVocabs };
              });
            }
          });
        }
      }
    } catch (err: any) {
      if (isMounted.current && currentSearchId === searchRequestId.current) {
        const msg = err.message || '';
        if (msg === 'QUOTA_EXCEEDED') {
          setAiSearchError("Daily AI limit reached. Please try again later.");
        } else {
          setAiSearchError("Search failed. Please check your connection and try again.");
        }
        setAiSearchLoading(false);
      }
    }
  };

  const handleSearchSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!localSearchQuery.trim()) return;
    
    // Trigger AI search (will be called when user presses enter or clicks arrow)
    performAISearch(localSearchQuery);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearchSubmit();
    }
  };

  const handlePasteAndSearch = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setLocalSearchQuery(text.trim());
        // Trigger AI search immediately for pasted content
        performAISearch(text.trim());
        searchInputRef.current?.focus();
      }
    } catch (err) {
      warn("Clipboard read failed, please paste manually", err);
      searchInputRef.current?.focus();
    }
  };

  const toggleSaveVocab = (vocab: VocabCard) => {
    const word = vocab.word || '';
    if (!word || !vocab.id) return;

    // Check if already saved
    const savedVocabMatch = items.find(item => 
      item.data.id === vocab.id || 
      (getItemTitle(item).toLowerCase().trim() === word.toLowerCase().trim() && 
       item.type === 'vocab' && 
       (item.data as VocabCard).sense === vocab.sense)
    );

    if (savedVocabMatch) {
      onDelete(savedVocabMatch.data.id);
    } else {
      onSave({
        data: vocab,
        type: 'vocab',
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(vocab.id, 'vocab')
      });
    }
  };

  // Scroll container ref for position restoration
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  // Restore scroll position on mount
  useEffect(() => {
    const savedScroll = localStorage.getItem('notebook_scroll_position');
    if (savedScroll && scrollContainerRef.current) {
      const scrollY = parseInt(savedScroll, 10);
      // Delay to ensure content is rendered
      setTimeout(() => {
        scrollContainerRef.current?.scrollTo(0, scrollY);
      }, 100);
    }
  }, []);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;
    
    // Top buffer zone
    if (currentScrollY < 50) {
      if (!showHeader) setShowHeader(true);
    } else if (Math.abs(currentScrollY - lastScrollY.current) > 10) {
      setShowHeader(currentScrollY < lastScrollY.current);
    }
    
    lastScrollY.current = currentScrollY;
    
    // Save scroll position for iOS PWA resume
    localStorage.setItem('notebook_scroll_position', currentScrollY.toString());
    
    onScroll?.(e);
  };
  
  const { displayItems, groupedItems, archivedItems, archivedGroups, hasExactMatch } = React.useMemo(() => {
    // 1. Fuzzy Search
    let processedItems = items;
    
    if (localSearchQuery.trim()) {
      const fuse = new Fuse(items, {
        keys: [
          'data.word',
          'data.query',
          'data.chinese',
          'data.translation'
        ],
        threshold: 0.3,
        ignoreLocation: true
      });
      
      processedItems = fuse.search(localSearchQuery).map(result => result.item);
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
          const titleA = getItemTitle(a);
          const titleB = getItemTitle(b);
          return titleA.localeCompare(titleB);
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
        const titleA = getItemTitle(a);
        const titleB = getItemTitle(b);
        return titleA.localeCompare(titleB);
      });
    
    // Helper to group items by title
    const groupByTitle = (itemList: StoredItem[]): ItemGroup[] => {
      const groupMap = new Map<string, StoredItem[]>();
      itemList.forEach(item => {
        const spelling = getItemSpelling(item);
        
        if (!spelling) return;
        
        if (!groupMap.has(spelling)) {
          groupMap.set(spelling, []);
        }
        groupMap.get(spelling)!.push(item);
      });
      
      const groups: ItemGroup[] = [];
      const seenTitles = new Set<string>();
      
      itemList.forEach(item => {
        const spelling = getItemSpelling(item);
        
        if (!spelling || seenTitles.has(spelling)) return;
        seenTitles.add(spelling);
        
        const groupItems = groupMap.get(spelling) || [];
        groups.push({
          title: spelling,
          items: groupItems
        });
      });
      
      return groups;
    };
    
    // Check for exact match (case-insensitive)
    const queryLower = localSearchQuery.toLowerCase().trim();
    const hasExactMatch = queryLower ? items.some(item => {
      if (item.isDeleted) return false;
      const spelling = getItemSpelling(item);
      return spelling === queryLower;
    }) : false;
    
    return { 
      displayItems: activeFiltered, 
      groupedItems: groupByTitle(activeFiltered),
      archivedItems: archivedFiltered,
      archivedGroups: groupByTitle(archivedFiltered),
      hasExactMatch
    };
  }, [items, sortMode, filterMode, localSearchQuery]);

  if (displayItems.length === 0 && !localSearchQuery && !aiSearchResult && !aiSearchLoading) {
    return (
      <div className="h-full bg-slate-50 overflow-y-auto">
        {/* Search Bar at top */}
        <div className="sticky top-0 z-10 bg-slate-50/90 backdrop-blur-md border-b border-slate-200/50 px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Notebook</h2>
              <p className="text-xs text-slate-500 font-medium">0 items saved</p>
            </div>
            <UserMenu 
              user={user} 
              onSignIn={onSignIn} 
              onSignOut={onSignOut} 
            />
          </div>
          <form onSubmit={handleSearchSubmit} className="relative group">
            <button
              type="button"
              onClick={handlePasteAndSearch}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 text-slate-400 hover:text-indigo-600 rounded-lg flex items-center justify-center transition-all hover:bg-slate-100"
              title="Paste and Search"
            >
              <Clipboard size={16} />
            </button>
            <input 
              ref={searchInputRef}
              type="text"
              value={localSearchQuery}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search for words or phrases to learn..."
              className="w-full pl-11 pr-20 py-2.5 bg-white border border-slate-200 rounded-xl text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-sm"
            />
            <button 
              type="submit"
              disabled={!localSearchQuery.trim() || aiSearchLoading}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-indigo-600 text-white rounded-lg flex items-center justify-center hover:bg-indigo-700 disabled:opacity-0 disabled:scale-90 transition-all shadow-sm"
              title="Search online"
            >
              {aiSearchLoading ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
            </button>
          </form>
        </div>

        {/* Empty state content */}
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
          <div className="relative mb-8 group">
            <div className="absolute inset-0 bg-indigo-500 rounded-3xl blur-2xl opacity-20 group-hover:opacity-30 transition-opacity duration-500"></div>
            <div className="w-24 h-24 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-3xl flex items-center justify-center text-white shadow-xl shadow-indigo-200 relative z-10 transform transition-transform duration-500 hover:rotate-3 hover:scale-105">
              <Search size={48} strokeWidth={2.5} />
            </div>
          </div>
          
          <h1 className="text-3xl font-bold text-slate-900 mb-3 tracking-tight">
            What would you like to learn?
          </h1>
          <p className="text-slate-500 max-w-xs mb-10 text-lg leading-relaxed">
            Search for any word, phrase, or idiom to get instant AI-powered insights and examples.
          </p>
          
          <div className="w-full max-w-md space-y-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Try These</p>
            <div className="flex flex-wrap justify-center gap-2">
              {[
                { t: "serendipity", i: "📚" },
                { t: "break the ice", i: "💬" },
                { t: "ephemeral", i: "⏰" },
                { t: "hit the nail on the head", i: "🎯" }
              ].map((item) => (
                <button 
                  key={item.t}
                  onClick={() => { setLocalSearchQuery(item.t); performAISearch(item.t); }}
                  className="bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50 transition-all active:scale-95 shadow-sm"
                >
                  <span className="mr-2 opacity-80">{item.i}</span> {item.t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} className="h-full overflow-y-auto overflow-x-hidden bg-slate-50" onScroll={handleScroll}>
      {/* Header */}
      <div className={`sticky top-0 z-10 bg-slate-50/90 backdrop-blur-md border-b border-slate-200/50 transition-transform duration-300 ${showHeader ? 'translate-y-0' : '-translate-y-full'}`}>
        <div className="px-6 py-4 flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Notebook</h2>
            <p className="text-xs text-slate-500 font-medium">{displayItems.length} {displayItems.length === 1 ? 'item' : 'items'} saved</p>
          </div>
          <div className="flex items-center gap-1 bg-white rounded-full p-1 border border-slate-100 shadow-sm flex-nowrap shrink-0">
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
                disabled={syncStatus === 'syncing' || !user}
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
            <div className="h-4 w-[1px] bg-slate-200 mx-1 shrink-0"></div>
            <div className="shrink-0">
              <UserMenu 
                user={user} 
                onSignIn={onSignIn} 
                onSignOut={onSignOut} 
              />
            </div>
          </div>
        </div>
        
        {/* Search Bar */}
        <div className="px-6 pb-4">
          <form onSubmit={handleSearchSubmit} className="relative group">
            {/* Paste button */}
            <button
              type="button"
              onClick={handlePasteAndSearch}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 text-slate-400 hover:text-indigo-600 rounded-lg flex items-center justify-center transition-all hover:bg-slate-100"
              title="Paste and Search"
            >
              <Clipboard size={16} />
            </button>
            <input 
              ref={searchInputRef}
              type="text"
              value={localSearchQuery}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search notebook or look up new words..."
              className="w-full pl-11 pr-20 py-2.5 bg-white border border-slate-200 rounded-xl text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-sm"
            />
            {localSearchQuery && (
              <button 
                type="button"
                onClick={() => setLocalSearchQuery('')}
                className="absolute right-10 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition-colors"
                title="Clear search"
              >
                <X size={14} />
              </button>
            )}
            {/* Search/Submit button */}
            <button 
              type="submit"
              disabled={!localSearchQuery.trim() || aiSearchLoading}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-indigo-600 text-white rounded-lg flex items-center justify-center hover:bg-indigo-700 disabled:opacity-0 disabled:scale-90 transition-all shadow-sm"
              title="Search online"
            >
              {aiSearchLoading ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
            </button>
          </form>
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

      <div className="px-3 pb-[calc(5rem+env(safe-area-inset-bottom))] grid gap-3 w-full max-w-screen-md mx-auto">
        {/* Show AI Search UI when no exact match OR when we already have AI search results */}
        {/* Keep showing results even after saving (which creates an exact match) */}
        {localSearchQuery.trim() && (!hasExactMatch || aiSearchResult || aiSearchLoading) && (
          <>
            {/* AI Search Loading */}
            {aiSearchLoading && !aiSearchResult && (
              <div className="flex flex-col items-center justify-center py-16 fade-in">
                <div className="relative">
                  <div className="absolute inset-0 bg-indigo-500 blur-xl opacity-20 animate-pulse"></div>
                  <Loader2 className="animate-spin text-indigo-600 mb-4 relative z-10" size={40} />
                </div>
                <p className="text-slate-500 font-medium animate-pulse">Analyzing "{localSearchQuery}"...</p>
              </div>
            )}

            {/* AI Search Error */}
            {aiSearchError && (
              <div className="p-6 text-center bg-red-50 rounded-2xl border border-red-100 flex flex-col items-center animate-in slide-in-from-bottom-4">
                <div className="w-12 h-12 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-3">
                  <AlertCircle size={24} />
                </div>
                <h3 className="font-bold text-slate-800 mb-1">Something went wrong</h3>
                <p className="text-sm text-slate-600 mb-4">{aiSearchError}</p>
                <Button variant="secondary" size="sm" className="text-red-600 hover:bg-red-100 border-red-200" onClick={() => performAISearch(localSearchQuery)}>
                  Try Again
                </Button>
              </div>
            )}

            {/* AI Search Results */}
            {aiSearchResult && (
              <div ref={aiSearchCarouselRef} className="fade-in">
                <div className="flex items-center gap-2 mb-3 px-1">
                  <Search size={14} className="text-indigo-500" />
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Search Results</span>
                </div>
                
                {/* Vocab Cards Carousel */}
                {(aiSearchResult.vocabs || []).length > 0 && (
                  <div className="space-y-3">
                    {(() => {
                      const vocabs = aiSearchResult.vocabs || [];
                      const totalVocabs = vocabs.length;
                      const currentVocab = vocabs[vocabIndex] || vocabs[0];
                      
                      if (!currentVocab) return null;
                      
                      const isVocabSaved = items.some(i => 
                        i.data.id === currentVocab.id || 
                        (getItemTitle(i).toLowerCase().trim() === (currentVocab.word || '').toLowerCase().trim() && 
                         i.type === 'vocab' && 
                         (i.data as VocabCard).sense === currentVocab.sense)
                      );
                      
                      return (
                        <>
                          {/* Meaning number badge */}
                          {totalVocabs > 1 && (
                            <div className="flex items-center gap-2 px-1">
                              <span className="text-xs text-slate-500">Meaning {vocabIndex + 1} of {totalVocabs}</span>
                            </div>
                          )}
                          
                          <VocabCardDisplay 
                            data={currentVocab} 
                            onSave={() => toggleSaveVocab(currentVocab)}
                            isSaved={isVocabSaved}
                            onSearch={onSearch}
                            scrollable={false}
                            className="border-slate-200 shadow-sm"
                          />
                          
                          {/* Dot indicators */}
                          {totalVocabs > 1 && (
                            <div className="flex justify-center gap-1.5">
                              {vocabs.map((_, idx) => (
                                <button
                                  key={idx}
                                  onClick={() => setVocabIndex(idx)}
                                  className={`w-2 h-2 rounded-full transition-all ${
                                    idx === vocabIndex 
                                      ? 'bg-indigo-600 w-4' 
                                      : 'bg-slate-300 hover:bg-slate-400'
                                  }`}
                                />
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* No Matches Prompt - show when no local results at all and no AI search active */}
            {!aiSearchLoading && !aiSearchResult && !aiSearchError && displayItems.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center fade-in">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                  <Search size={28} className="text-slate-400" />
                </div>
                <h3 className="text-lg font-bold text-slate-700 mb-2">No matches in notebook</h3>
                <p className="text-sm text-slate-500 mb-6 max-w-xs">
                  "{localSearchQuery}" isn't saved yet. Press the arrow to search online.
                </p>
              </div>
            )}
          </>
        )}

        {/* Regular notebook items */}
        {groupedItems.map((group, index) => (
          <NotebookGroup
            key={group.title}
            group={group}
            groups={groupedItems}
            groupIndex={index}
            openItemId={openItemId}
            setOpenItemId={setOpenItemId}
            onDelete={onDelete}
            onSearch={onSearch}
            onViewDetail={onViewDetail}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
          />
        ))}

        {/* Archived Section */}
        {archivedItems.length > 0 && (
          <div className="mt-6 pt-4 border-t-2 border-slate-200">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full flex items-center justify-between px-4 py-3 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Archive size={18} className="text-slate-500" />
                <span className="font-bold text-slate-700">Archived</span>
                <span className="text-sm text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full">
                  {archivedItems.length} {archivedItems.length === 1 ? 'item' : 'items'}
                </span>
              </div>
              {showArchived ? (
                <ChevronUp size={18} className="text-slate-500" />
              ) : (
                <ChevronDown size={18} className="text-slate-500" />
              )}
            </button>

            {showArchived && (
              <div className="grid gap-4 mt-4 animate-in slide-in-from-top-2 duration-200">
                {archivedGroups.map((group, index) => (
                  <NotebookGroup
                    key={`archived-${group.title}`}
                    group={group}
                    groups={archivedGroups}
                    groupIndex={index}
                    openItemId={openItemId}
                    setOpenItemId={setOpenItemId}
                    onDelete={onDelete}
                    onSearch={onSearch}
                    onViewDetail={onViewDetail}
                    onArchive={onArchive}
                    onUnarchive={onUnarchive}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
