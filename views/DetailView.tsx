import React, { useState, useRef, useEffect, useCallback } from 'react';
import { VocabCard, SearchResult, StoredItem, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, ItemGroup, isPhraseItem, isVocabItem, TaskType } from '../types';
import { ArrowLeft, Bookmark, BookmarkMinus, Search as SearchIcon, RefreshCw, Trash2, Archive, MoreVertical, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, RotateCcw, Sparkles, Flame, CheckCircle2, Clock } from 'lucide-react';
import { Button } from '../components/Button';
import { VocabCardDisplay } from '../components/VocabCard';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { OfflineImage } from '../components/OfflineImage';
import ReactMarkdown from 'react-markdown';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { useKeyboardNavigation, useWheelNavigation } from '../hooks';
import { speak } from '../services/speech';
import { log, warn } from '../services/logger';

// Helper to format relative time for next review
const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = timestamp - now;
  
  if (diff <= 0) return 'now';
  
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
};

// Color classes for mastery levels
const getMasteryColors = (color: string) => {
  const colorMap: Record<string, { bg: string; text: string; bar: string }> = {
    slate: { bg: 'bg-slate-100', text: 'text-slate-600', bar: 'bg-slate-400' },
    orange: { bg: 'bg-orange-100', text: 'text-orange-600', bar: 'bg-orange-400' },
    amber: { bg: 'bg-amber-100', text: 'text-amber-600', bar: 'bg-amber-400' },
    blue: { bg: 'bg-blue-100', text: 'text-blue-600', bar: 'bg-blue-400' },
    emerald: { bg: 'bg-emerald-100', text: 'text-emerald-600', bar: 'bg-emerald-400' },
    purple: { bg: 'bg-purple-100', text: 'text-purple-600', bar: 'bg-purple-400' },
  };
  return colorMap[color] || colorMap.slate;
};

interface DetailViewProps {
  // New group-based navigation props
  groups?: ItemGroup[];
  initialGroupIndex?: number;
  initialItemIndex?: number;

  // Legacy single item mode (for Search view)
  items?: StoredItem[]; // Fallback if groups not provided
  initialIndex?: number;
  
  onClose: () => void;
  onSave: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  savedItems: StoredItem[];
  onSearch: (text: string) => void;
  onRefresh?: (text: string) => void; // Force a real AI search, bypassing local cache
  onLazyLoadImage?: (itemId: string) => void; // Fetch image from Firebase if missing locally
  onUpdateSRS?: (itemId: string, quality: number, taskType: TaskType, responseTime: number) => void; // Direct SRS update
}

export const DetailView: React.FC<DetailViewProps> = ({ 
  groups,
  initialGroupIndex = 0,
  initialItemIndex = 0,
  items, // Legacy support
  initialIndex = 0,
  onClose, 
  onSave, 
  onDelete,
  onArchive,
  savedItems,
  onSearch,
  onRefresh,
  onLazyLoadImage,
  onUpdateSRS
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  // State for 2D navigation
  const [currentGroupIndex, setCurrentGroupIndex] = useState(groups ? initialGroupIndex : 0);
  const [currentItemIndex, setCurrentItemIndex] = useState(groups ? initialItemIndex : initialIndex);
  
  const [isAnimating, setIsAnimating] = useState(false);
  const [showHeader, setShowHeader] = useState(false); // Hidden by default, shown on short swipe down or H key
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSuccessAnim, setShowSuccessAnim] = useState(false);
  const lastScrollY = useRef(0);
  
  // Sync local indices when props change (e.g., after delete/archive updates detailContext)
  useEffect(() => {
    if (groups) {
      // Clamp indices to valid range
      const maxGroupIndex = Math.max(0, groups.length - 1);
      const clampedGroupIndex = Math.min(initialGroupIndex, maxGroupIndex);
      
      const maxItemIndex = groups[clampedGroupIndex] 
        ? Math.max(0, groups[clampedGroupIndex].items.length - 1) 
        : 0;
      const clampedItemIndex = Math.min(initialItemIndex, maxItemIndex);
      
      setCurrentGroupIndex(clampedGroupIndex);
      setCurrentItemIndex(clampedItemIndex);
    }
  }, [groups, initialGroupIndex, initialItemIndex]);
  
  // Determine current item to display
  let currentItem: StoredItem | null = null;
  let currentGroup: ItemGroup | null = null;
  let hasNextGroup = false;
  let hasPrevGroup = false;
  let hasNextItem = false;
  let hasPrevItem = false;

  if (groups && groups.length > 0) {
    // Safety: clamp indices to valid range
    const safeGroupIndex = Math.min(currentGroupIndex, groups.length - 1);
    currentGroup = groups[safeGroupIndex];
    
    if (currentGroup && currentGroup.items.length > 0) {
      const safeItemIndex = Math.min(currentItemIndex, currentGroup.items.length - 1);
      currentItem = currentGroup.items[safeItemIndex];
      
      hasNextGroup = safeGroupIndex < groups.length - 1;
      hasPrevGroup = safeGroupIndex > 0;
      hasNextItem = safeItemIndex < currentGroup.items.length - 1;
      hasPrevItem = safeItemIndex > 0;
    }
  } else if (items && items.length > 0) {
    // Legacy flat list mode
    currentItem = items[currentItemIndex];
    hasNextItem = currentItemIndex < items.length - 1;
    hasPrevItem = currentItemIndex > 0;
  }
  
  // Reset item index when group changes
  useEffect(() => {
    if (groups) {
        setCurrentItemIndex(0);
    }
  }, [currentGroupIndex, groups]);

  // Lazy load image from Firebase if missing locally
  useEffect(() => {
    if (!currentItem || !onLazyLoadImage) return;
    
    const itemId = currentItem.data.id;
    const imageUrl = getItemImageUrl(currentItem);
    
    // Check if this item is saved and missing an image
    const isSaved = savedItems.some(i => i.data.id === itemId);
    const hasImage = imageUrl && imageUrl.startsWith('data:image/');
    
    if (isSaved && !hasImage) {
      // Trigger lazy load from Firebase
      onLazyLoadImage(itemId);
    }
    
    // Also check vocab images for phrase type
    if (isSaved && isPhraseItem(currentItem) && currentItem.data.vocabs) {
      currentItem.data.vocabs.forEach((vocab: VocabCard) => {
        if (!vocab.imageUrl && vocab.id) {
          // The parent item ID is used - Firebase stores the whole phrase
          // so we only need to fetch the parent once
        }
      });
    }
  }, [currentItem?.data.id, onLazyLoadImage, savedItems]);


  if (!currentItem) {
    return null;
  }
  
  const data = currentItem.data;
  const type = currentItem.type;

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const currentScrollY = target.scrollTop;

    // Header auto-hide logic: hide when scrolling down, but only show via gesture or keyboard
    if (showHeader && currentScrollY > lastScrollY.current && currentScrollY > 50) {
      setShowHeader(false);
    }
    
    lastScrollY.current = currentScrollY;
  };
  
  // Touch Handling for swipe navigation
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  
  const onContentTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };
  
  const onContentTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null || isAnimating) return;
    
    // Check if user is selecting text - don't interfere with text selection on iOS
    const selection = window.getSelection();
    const hasTextSelection = selection && selection.toString().trim().length > 0;
    if (hasTextSelection) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    
    const diffX = e.changedTouches[0].clientX - touchStartX.current;
    const diffY = e.changedTouches[0].clientY - touchStartY.current;
    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);
    const swipeThreshold = 50;
    
    // Check scroll position for edge-based navigation
    const container = scrollContainerRef.current;
    const scrollTop = container?.scrollTop || 0;
    const scrollHeight = container?.scrollHeight || 0;
    const clientHeight = container?.clientHeight || 0;
    const isAtTop = scrollTop <= 5;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
    
    // Vertical Swipe (Groups/Words) - edge-based detection
    const isVerticalSwipe = absY > absX * 1.5 && absY > swipeThreshold;
    
    // Use distance to distinguish short vs long swipes
    // Short swipe down (50-120px): show header
    // Long swipe down (>120px): navigate to previous/next word
    const shortSwipeMin = 50;
    const shortSwipeMax = 120;
    const longSwipeMin = 120;
    const horizontalSwipeMin = 60; // More sensitive for horizontal navigation
    const isShortSwipe = absY >= shortSwipeMin && absY < shortSwipeMax;
    const isLongSwipe = absY >= longSwipeMin;
    
    // Horizontal Swipe (Meanings) - more sensitive threshold
    const isHorizontalSwipe = absX > absY * 1.5 && absX > horizontalSwipeMin;

    // Short swipe down at top -> show header bar
    if (isVerticalSwipe && isShortSwipe && diffY > 0 && isAtTop) {
      setShowHeader(true);
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    
    // Skip if swipe is too short for navigation
    if (!isLongSwipe && isVerticalSwipe) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }

    if (isVerticalSwipe && isLongSwipe && groups) {
      // Swipe UP -> Next Group (Word) - only when at bottom or content is short
      if (diffY < -longSwipeMin && hasNextGroup && (isAtBottom || scrollHeight <= clientHeight)) {
        setShowHeader(false); // Hide header on navigation
        setIsAnimating(true);
        setCurrentGroupIndex(prev => prev + 1);
        setCurrentItemIndex(0); // Reset to first meaning
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setTimeout(() => setIsAnimating(false), 300);
      }
      // Swipe DOWN -> Previous Group (Word) - only when at top
      else if (diffY > longSwipeMin && hasPrevGroup && isAtTop) {
        setShowHeader(false); // Hide header on navigation
        setIsAnimating(true);
        setCurrentGroupIndex(prev => prev - 1);
        setCurrentItemIndex(0); // Reset to first meaning
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setTimeout(() => setIsAnimating(false), 300);
      }
    }
    else if (isHorizontalSwipe) {
      const totalItems = currentGroup ? currentGroup.items.length : (items ? items.length : 0);
      
      // Swipe LEFT -> Next Item (Meaning) - loops forever (even with 1 item for consistent UX)
      if (diffX < -horizontalSwipeMin && totalItems >= 1) {
        setShowHeader(false); // Hide header on navigation
        setIsAnimating(true);
        setCurrentItemIndex(prev => (prev + 1) % totalItems); // Loop back to 0 when at end
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setTimeout(() => setIsAnimating(false), 300);
        
        // Only pronounce directly when single item (index doesn't change, so useEffect won't trigger)
        if (totalItems === 1 && currentItem) {
          const wordToSpeak = currentItem.type === 'phrase' 
            ? (currentItem.data as SearchResult).query 
            : (currentItem.data as VocabCard).word;
          if (wordToSpeak) speak(wordToSpeak);
        }
      }
      
      // Swipe RIGHT -> Prev Item (Meaning) or Close
      if (diffX > horizontalSwipeMin) {
        if (hasPrevItem) {
          setShowHeader(false); // Hide header on navigation
          setIsAnimating(true);
          setCurrentItemIndex(prev => prev - 1);
          if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
          setTimeout(() => setIsAnimating(false), 300);
        } else {
          // Close view if swiping right with no previous item
          onClose();
        }
      }
    }
    
    touchStartX.current = null;
    touchStartY.current = null;
  };
  
  const title = type === 'phrase' ? (data as SearchResult).query : (data as VocabCard).word;

  // Auto-pronounce word when card changes
  useEffect(() => {
    if (!title) return;
    
    // Small delay to let animation settle before pronouncing
    const timer = setTimeout(() => {
      speak(title);
    }, 100);
    
    return () => clearTimeout(timer);
  }, [title, currentGroupIndex, currentItemIndex]);

  // P key to pronounce current word
  // Moved to bottom to access handlers
  
  // Find saved item - first try by ID (most reliable), then fallback to title+sense matching
  const savedItemMatch = savedItems.find(item => item.data.id === data.id) || 
    savedItems.find(item => 
      getItemTitle(item).toLowerCase().trim() === (title || '').toLowerCase().trim() &&
      (item.type === 'phrase' || (item.data as VocabCard).sense === (data as VocabCard).sense)
    );
  const isSaved = !!savedItemMatch;

  // Calculate global stats for saved items
  const activeItems = savedItems.filter(i => !i.isDeleted && !i.isArchived);
  const memorizedCount = activeItems.filter(i => i.srs.memoryStrength >= 70).length;
  const dueToday = activeItems.filter(i => i.srs.nextReview <= Date.now()).length;
  
  // Get mastery info for current item
  const mastery = savedItemMatch ? SRSAlgorithm.getMasteryLevel(savedItemMatch.srs) : null;
  const masteryColors = mastery ? getMasteryColors(mastery.color) : null;

  const handleToggleSave = useCallback(() => {
    if (isSaved && savedItemMatch) {
      onDelete(savedItemMatch.data.id);
    } else {
      if (!data.id) return;
      
      onSave({
        data: data,
        type: type,
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(data.id, type)
      });
    }
  }, [isSaved, savedItemMatch, data, type, onDelete, onSave]);

  // Navigation handlers for keyboard
  const handlePrevItem = useCallback(() => {
    if (hasPrevItem && !isAnimating) {
      setIsAnimating(true);
      setCurrentItemIndex(prev => prev - 1);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      setTimeout(() => setIsAnimating(false), 300);
    }
  }, [hasPrevItem, isAnimating]);

  const handleNextItem = useCallback(() => {
    const totalItems = currentGroup ? currentGroup.items.length : (items ? items.length : 0);
    if (totalItems >= 1 && !isAnimating) {
      setIsAnimating(true);
      setCurrentItemIndex(prev => (prev + 1) % totalItems); // Loop back to 0 when at end
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      setTimeout(() => setIsAnimating(false), 300);
      
      // Only pronounce directly when single item (index doesn't change, so useEffect won't trigger)
      if (totalItems === 1 && currentItem) {
        const wordToSpeak = currentItem.type === 'phrase' 
          ? (currentItem.data as SearchResult).query 
          : (currentItem.data as VocabCard).word;
        if (wordToSpeak) speak(wordToSpeak);
      }
    }
  }, [currentGroup, items, isAnimating, currentItem]);

  const handlePrevGroup = useCallback(() => {
    if (hasPrevGroup && !isAnimating && groups) {
      setIsAnimating(true);
      setCurrentGroupIndex(prev => prev - 1);
      setCurrentItemIndex(0);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      setTimeout(() => setIsAnimating(false), 300);
    }
  }, [hasPrevGroup, isAnimating, groups]);

  const handleNextGroup = useCallback(() => {
    if (hasNextGroup && !isAnimating && groups) {
      setIsAnimating(true);
      setCurrentGroupIndex(prev => prev + 1);
      setCurrentItemIndex(0);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      setTimeout(() => setIsAnimating(false), 300);
    }
  }, [hasNextGroup, isAnimating, groups]);

  // Keyboard navigation
  useKeyboardNavigation({
    onEscape: onClose,
    onArrowLeft: handlePrevItem,
    onArrowRight: handleNextItem,
    onArrowUp: handlePrevGroup,
    onArrowDown: handleNextGroup,
    onSave: handleToggleSave,
    enabled: !showDeleteConfirm && !showActionMenu,
  });

  // Trackpad wheel navigation
  useWheelNavigation({
    onScrollLeft: handlePrevItem,
    onScrollRight: handleNextItem,
    containerRef: scrollContainerRef,
    threshold: 80,
    enabled: !!(currentGroup && currentGroup.items.length >= 1),
  });

  const handleVocabSearch = (term: string) => {
    onClose();
    onSearch(term);
  };

  const handleSaveVocab = (vocab: VocabCard) => {
    const vocabSpelling = (vocab.word || '').toLowerCase().trim();
    const isAlreadySaved = savedItems.some(i => 
      getItemSpelling(i) === vocabSpelling && getItemSense(i) === vocab.sense
    );

    if (isAlreadySaved) {
      const existingItem = savedItems.find(i => 
        getItemSpelling(i) === vocabSpelling && getItemSense(i) === vocab.sense
      );
      if (existingItem) {
        onDelete(existingItem.data.id);
      }
    } else {
      onSave({
        data: vocab,
        type: 'vocab',
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(vocab.id, 'vocab')
      });
    }
  };

  const handleDeleteItem = () => {
    // Use savedItemMatch ID if available, otherwise use currentItem's ID
    const idToDelete = savedItemMatch?.data.id || data.id;
    if (!idToDelete) {
      warn('Delete failed: No valid ID found');
      return;
    }
    
    log('🗑️ DetailView: Deleting item:', idToDelete, title);
    setShowDeleteConfirm(false);
    setShowActionMenu(false);
    
    // App.tsx handles updating detailContext and navigation
    onDelete(idToDelete);
  };

  const handleArchiveItem = () => {
    if (!onArchive) return;
    
    // Use savedItemMatch ID if available, otherwise use currentItem's ID
    const idToArchive = savedItemMatch?.data.id || data.id;
    if (!idToArchive) {
      warn('Archive failed: No valid ID found');
      return;
    }
    
    log('📦 DetailView: Archiving item:', idToArchive, title);
    setShowActionMenu(false);
    
    // App.tsx handles updating detailContext and navigation
    onArchive(idToArchive);
  };

  const handleResetSRS = useCallback(() => {
    // Reset SRS progress
    if (!data.id) return;
    
    log('🔄 DetailView: Resetting SRS for item:', data.id, title);
    
    const targetTitle = (title || '').toLowerCase().trim();
    // Find all siblings to reset them together (Shared SRS)
    const siblings = savedItems.filter(item => 
      !item.isDeleted && getItemTitle(item).toLowerCase().trim() === targetTitle
    );

    if (siblings.length > 0) {
      siblings.forEach(sibling => {
         const newSRS = SRSAlgorithm.createNew(sibling.data.id, sibling.type);
         // Preserve original savedAt if possible, or update? 
         // Resetting usually implies starting over, so updating savedAt is acceptable, 
         // but keeping original savedAt might be better for history. 
         // Let's keep original savedAt for siblings.
         onSave({ 
           ...sibling, 
           srs: newSRS,
           // We don't change savedAt to preserve "Added on" date, unless we want to "bump" it.
           // Let's treat it as a fresh start for the Algorithm, but the item itself is old.
         });
      });
    } else {
       // Fallback for current item if not found in saved list (e.g. slight delay in sync)
       const newSRS = SRSAlgorithm.createNew(data.id, type);
       onSave({
         data: data,
         type: type,
         savedAt: Date.now(),
         srs: newSRS
       });
    }
    
    setShowActionMenu(false);
  }, [data, title, type, onSave, savedItems]);

  const handleRemember = useCallback(() => {
    log('🧠 DetailView: Marking as remembered via shortcut/gesture');
    
    // Trigger Success Animation
    setShowSuccessAnim(true);
    setTimeout(() => setShowSuccessAnim(false), 1500);

    // Default response time for manual "I know this" action
    const DEFAULT_RESPONSE_TIME = 1000;  
    
    const targetTitle = (title || '').toLowerCase().trim();
    // Find all siblings to update them together (Shared SRS)
    const siblings = savedItems.filter(item => 
      !item.isDeleted && getItemTitle(item).toLowerCase().trim() === targetTitle
    );
    
    if (siblings.length > 0) {
      // Use the dedicated onUpdateSRS if available (preferred - handles shared SRS atomically)
      if (onUpdateSRS) {
        // Update using the first sibling's ID - onUpdateSRS handles all siblings with same title
        log('🧠 DetailView: Using onUpdateSRS for atomic shared SRS update');
        onUpdateSRS(siblings[0].data.id, 4, 'recall', DEFAULT_RESPONSE_TIME);
      } else {
        // Fallback: Update existing items (all siblings) via onSave
        log('🧠 DetailView: Using onSave fallback for SRS update');
        siblings.forEach(sibling => {
          const updatedSRS = SRSAlgorithm.updateAfterReview(
            sibling.srs,
            4, // Quality: Memorized (Good/Easy)
            'recall',
            DEFAULT_RESPONSE_TIME
          );
          
          onSave({
            ...sibling,
            srs: updatedSRS
          });
        });
      }
    } else {
      // Create new item and immediately mark as remembered
      if (!data.id) return;
      
      let newSRS = SRSAlgorithm.createNew(data.id, type);
      
      // Apply the "remembered" update immediately
      newSRS = SRSAlgorithm.updateAfterReview(
        newSRS,
        4, // Quality: Memorized
        'recall',
        DEFAULT_RESPONSE_TIME
      );
      
      onSave({
        data: data,
        type: type,
        savedAt: Date.now(),
        srs: newSRS
      });
    }
  }, [data, type, savedItems, onSave, onUpdateSRS, title]);

  const handleDoubleClick = () => {
    // Avoid triggering when selecting text
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
       return;
    }

    log('👆👆 DetailView: Double click detected');
    handleRemember();
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (showDeleteConfirm || showActionMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if in input
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      // H: Toggle header visibility
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setShowHeader(prev => !prev);
      }

      // P: Pronounce
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (title) speak(title);
      }
      
      // R: Remember (Shift+R: Reset)
      if (e.key === 'r' || e.key === 'R') {
         if (e.shiftKey) {
             e.preventDefault();
             handleResetSRS();
         } else {
             e.preventDefault();
             handleRemember();
         }
      }
      
      // S: Toggle save
      if (e.key === 's' || e.key === 'S') {
        if (!e.metaKey && !e.ctrlKey) { // Don't interfere with Cmd+S
          e.preventDefault();
          handleToggleSave();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [title, showDeleteConfirm, showActionMenu, handleRemember, handleResetSRS, handleToggleSave]);

  return (
    <div 
      className="fixed inset-0 z-50 bg-slate-50 flex flex-col animate-in slide-in-from-right duration-300 shadow-2xl"
    >
      <div 
        ref={scrollContainerRef}
        className={`flex-1 overflow-y-auto no-scrollbar transition-opacity duration-300 ${isAnimating ? 'opacity-50' : 'opacity-100'}`}
        onScroll={handleScroll}
        onTouchStart={onContentTouchStart}
        onTouchEnd={onContentTouchEnd}
        onDoubleClick={handleDoubleClick}
      >
        {/* Minimal meaning indicator when header is hidden */}
        {!showHeader && currentGroup && currentGroup.items.length > 1 && (
          <div className="sticky top-0 z-20 flex justify-center pt-2 pb-1">
            <div className="flex items-center gap-1">
              {currentGroup.items.map((_, idx) => (
                <div
                  key={idx}
                  className={`rounded-full transition-all duration-200 ${
                    idx === currentItemIndex 
                      ? 'w-1.5 h-1.5 bg-violet-400' 
                      : 'w-1 h-1 bg-slate-300'
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Header - combined with progress bar */}
        <div className={`sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200/60 shrink-0 transition-all duration-300 overflow-hidden ${showHeader ? 'max-h-32 opacity-100' : 'max-h-0 opacity-0 border-b-0'}`}>
          {/* Top row: navigation and actions */}
          <div className="px-4 py-2 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} className="text-slate-600 -ml-2 hover:bg-slate-100/50">
                <ArrowLeft size={20} className="mr-1" /> Close
              </Button>
              {/* Meaning position indicator - shows which card in the group */}
              {currentGroup && currentGroup.items.length > 1 && (
                <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2.5 py-1 rounded-full border border-violet-100">
                  {currentItemIndex + 1}/{currentGroup.items.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => {
                  const searchText = type === 'phrase' ? (data as SearchResult).query : (data as VocabCard).word;
                  // Use onRefresh if available (forces real AI search), otherwise fall back to onSearch
                  if (onRefresh) {
                    onRefresh(searchText);
                  } else {
                    onSearch(searchText);
                  }
                }}
                className="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
                title="Refresh with AI"
              >
                <RefreshCw size={18} />
              </Button>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={handleToggleSave}
                className={`px-3 gap-1.5 rounded-lg border ${isSaved ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'border-transparent text-slate-500 hover:bg-slate-100'}`}
              >
                {isSaved ? <BookmarkMinus size={18} /> : <Bookmark size={18} />}
                <span className="text-xs font-bold">{isSaved ? 'Saved' : 'Save'}</span>
              </Button>
              {/* Action menu for saved items */}
              {isSaved && (
                <div className="relative">
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={() => setShowActionMenu(!showActionMenu)}
                    className="text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                    title="More actions"
                  >
                    <MoreVertical size={18} />
                  </Button>
                </div>
              )}
            </div>
          </div>
          
          {/* Bottom row: Progress bar - shown for saved items */}
          {isSaved && savedItemMatch && mastery && masteryColors && (
            <div className="px-4 pb-2">
              <div className="flex items-center gap-2 text-xs">
                {/* Mastery badge with percentage */}
                <span className={`${masteryColors.bg} ${masteryColors.text} px-2 py-0.5 rounded-full font-semibold`}>
                  {mastery.label} {Math.round(mastery.percentage)}%
                </span>
                
                {/* Progress bar */}
                <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div 
                    className={`h-full ${masteryColors.bar} transition-all duration-300`}
                    style={{ width: `${mastery.percentage}%` }}
                  />
                </div>
                
                {/* Stats */}
                <span className="text-slate-400 whitespace-nowrap">
                  {savedItemMatch.srs.totalReviews}×
                </span>
                {savedItemMatch.srs.correctStreak > 0 && (
                  <span className="text-orange-500 flex items-center gap-0.5">
                    <Flame size={12} />
                    {savedItemMatch.srs.correctStreak}
                  </span>
                )}
                <span className="text-slate-300">•</span>
                <span className="text-emerald-600 flex items-center gap-0.5">
                  <CheckCircle2 size={12} />
                  {memorizedCount}
                </span>
                <span className="text-slate-300">•</span>
                <span className="text-amber-600 flex items-center gap-0.5">
                  <Clock size={12} />
                  {dueToday}
                </span>
                <span className="text-slate-300">•</span>
                <span className="text-slate-500">
                  {savedItemMatch.srs.nextReview <= Date.now() ? 'due' : formatRelativeTime(savedItemMatch.srs.nextReview)}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 pb-24">

          {type === 'vocab' && (
            <VocabCardDisplay 
              data={data as VocabCard}
              isSaved={isSaved}
              onSave={handleToggleSave}
              showSave={false}
              onExpand={undefined}
              onSearch={handleVocabSearch}
              scrollable={false}
              className="min-h-full shadow-none border-0 !p-0 bg-transparent !h-auto !overflow-visible max-w-3xl mx-auto"
              showRefresh={false}
            />
          )}

          {type === 'phrase' && (
            <div className="space-y-6 max-w-3xl mx-auto">
              <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="bg-slate-100 relative overflow-hidden flex items-center justify-center group">
                  {(data as SearchResult).imageUrl ? (
                    <OfflineImage src={(data as SearchResult).imageUrl} alt="Visual context" className="w-full fade-in transition-transform duration-700 group-hover:scale-105" />
                  ) : (
                    <div className="flex flex-col items-center text-slate-400">
                      <SearchIcon className="mb-2 opacity-30" size={32}/>
                      <span className="text-xs uppercase font-bold tracking-wider opacity-60">{(data as SearchResult).visualKeyword}</span>
                    </div>
                  )}
                </div>

                <div className="p-6 sm:p-8">
                  <div className="mb-6">
                    <h2 className="text-2xl font-bold text-slate-900 leading-tight mb-2">{(data as SearchResult).translation}</h2>
                    <p className="text-lg text-slate-600 mb-3 leading-relaxed">{(data as SearchResult).query}</p>
                    <PronunciationBlock 
                      text={(data as SearchResult).query}
                      ipa={(data as SearchResult).pronunciation}
                      className="text-base bg-slate-100 px-2 py-1 rounded-lg w-full"
                    />
                  </div>
                  
                  <div className="prose prose-indigo prose-sm sm:prose-base max-w-none text-slate-600">
                    <ReactMarkdown 
                      components={{
                        strong: ({node, ...props}) => <span className="font-bold text-indigo-700 bg-indigo-50 px-1 rounded" {...props} />
                      }}
                    >
                      {(data as SearchResult).grammar}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>

              {((data as SearchResult).vocabs || []).length > 0 && (
                <div>
                  <div className="px-2 mb-4 flex items-center gap-2">
                    <SearchIcon size={16} className="text-indigo-500" />
                    <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Key Vocabulary</h3>
                  </div>
                  <div className="grid gap-4">
                    {((data as SearchResult).vocabs || []).map((vocab) => (
                      <VocabCardDisplay 
                        key={vocab.id}
                        data={vocab} 
                        onSave={() => handleSaveVocab(vocab)}
                        isSaved={savedItems.some(i => getItemSpelling(i) === (vocab.word || '').toLowerCase().trim() && getItemSense(i) === vocab.sense)}
                        onSearch={handleVocabSearch}
                        scrollable={false}
                        showSave={true}
                        className="!h-auto !overflow-visible border-slate-200 shadow-sm hover:shadow-md transition-shadow"
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Desktop navigation buttons */}
          <div className="hidden md:flex fixed bottom-6 left-1/2 -translate-x-1/2 z-40 items-center gap-2 bg-white/90 backdrop-blur-sm rounded-full px-4 py-2 shadow-lg border border-slate-200">
            {/* Previous word */}
            {hasPrevGroup && (
              <button
                onClick={handlePrevGroup}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Previous word (↑)"
              >
                <ChevronUp size={16} />
                <span className="text-xs font-medium">Prev word</span>
              </button>
            )}
            
            {/* Previous meaning */}
            {hasPrevItem && (
              <button
                onClick={handlePrevItem}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Previous meaning (←)"
              >
                <ChevronLeft size={16} />
                <span className="text-xs font-medium">Prev</span>
              </button>
            )}
            
            {/* Position indicator */}
            {currentGroup && currentGroup.items.length > 1 && (
              <span className="text-xs font-bold text-violet-600 bg-violet-50 px-3 py-1 rounded-full">
                {currentItemIndex + 1}/{currentGroup.items.length}
              </span>
            )}
            
            {/* Next meaning - always available for looping (even with 1 item) */}
            {currentGroup && currentGroup.items.length >= 1 && (
              <button
                onClick={handleNextItem}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Next meaning (→)"
              >
                <span className="text-xs font-medium">Next</span>
                <ChevronRight size={16} />
              </button>
            )}
            
            {/* Next word */}
            {hasNextGroup && (
              <button
                onClick={handleNextGroup}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Next word (↓)"
              >
                <span className="text-xs font-medium">Next word</span>
                <ChevronDown size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Success Animation Overlay */}
      {showSuccessAnim && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 backdrop-blur-md px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 animate-in zoom-in fade-in slide-in-from-bottom-4 duration-300">
            <Sparkles className="text-amber-500 w-6 h-6 animate-pulse" />
            <span className="text-slate-800 font-bold text-lg">Remembered!</span>
          </div>
        </div>
      )}

      {/* Action menu dropdown - positioned fixed to escape overflow */}
      {showActionMenu && (
        <>
          <div 
            className="fixed inset-0 z-[55]" 
            onClick={() => setShowActionMenu(false)}
          />
          <div className="fixed right-4 top-12 z-[56] bg-white rounded-xl shadow-xl border border-slate-200 py-1 min-w-[180px] animate-in fade-in zoom-in-95 duration-150">
            {onArchive && (
              <button
                onClick={handleArchiveItem}
                className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-amber-50 hover:text-amber-700 flex items-center gap-2.5 transition-colors"
              >
                <Archive size={16} />
                Archive
              </button>
            )}
            <button
              onClick={handleResetSRS}
              className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 flex items-center gap-2.5 transition-colors"
            >
              <RotateCcw size={16} />
              Reset Memory Strength
            </button>
            <button
              onClick={() => {
                setShowActionMenu(false);
                setShowDeleteConfirm(true);
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-rose-600 hover:bg-rose-50 flex items-center gap-2.5 transition-colors"
            >
              <Trash2 size={16} />
              Delete
            </button>
          </div>
        </>
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div 
          className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-150"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div 
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center animate-in zoom-in-95 duration-150"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-14 h-14 bg-rose-100 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <Trash2 size={28} />
            </div>
            <h3 className="text-xl font-bold text-slate-800 mb-2">Delete this word?</h3>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed">
              This will remove <span className="font-semibold text-slate-700">"{title}"</span> from your notebook and erase all learning progress.
            </p>
            <div className="flex gap-3">
              <Button 
                variant="ghost" 
                onClick={() => setShowDeleteConfirm(false)} 
                className="flex-1 py-3"
              >
                Cancel
              </Button>
              <Button 
                variant="primary" 
                onClick={handleDeleteItem}
                className="flex-1 py-3 bg-rose-500 hover:bg-rose-600 border-0 text-white"
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
