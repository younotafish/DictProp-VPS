import React, { useState, useRef, useEffect } from 'react';
import { StoredItem, SyncStatus, AppUser } from '../types';
import { Trash2, BookOpen, Layers, Loader2, RefreshCw, Type, ArrowDownAZ, Sparkles, Filter, WifiOff, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { Button } from '../components/Button';
import { UserMenu } from '../components/UserMenu';
import { PronunciationBlock } from '../components/PronunciationBlock';

// Group type for items with same spelling
interface ItemGroup {
  title: string;
  items: StoredItem[];
}

interface NotebookItemProps {
  item: StoredItem;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: () => void;
  // For carousel mode
  totalInGroup?: number;
  indexInGroup?: number;
}

const NotebookItem: React.FC<NotebookItemProps> = ({
  item, isOpen, onOpen, onClose, onDelete, onSearch, onViewDetail, totalInGroup = 1, indexInGroup = 0
}) => {
  const touchStart = useRef<{x: number, y: number, time: number} | null>(null);
  const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  
  const SWIPE_THRESHOLD = 80; // Increased threshold
  const MAX_OFFSET = 100;
  const DIRECTION_LOCK_THRESHOLD = 15; // Minimum movement to determine direction
  const HORIZONTAL_RATIO = 2.5; // Horizontal must be this much greater than vertical
  
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      time: Date.now()
    };
    directionLocked.current = null;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current) return;

    const deltaX = e.touches[0].clientX - touchStart.current.x;
    const deltaY = e.touches[0].clientY - touchStart.current.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // Lock direction once we have enough movement
    if (!directionLocked.current && (absX > DIRECTION_LOCK_THRESHOLD || absY > DIRECTION_LOCK_THRESHOLD)) {
      // Require strongly horizontal movement to trigger swipe
      if (absX > absY * HORIZONTAL_RATIO && absX > DIRECTION_LOCK_THRESHOLD) {
        directionLocked.current = 'horizontal';
      } else {
        directionLocked.current = 'vertical';
      }
    }

    // Only handle horizontal swipes, let vertical scroll naturally
    if (directionLocked.current === 'horizontal') {
      e.preventDefault();
      setIsDragging(true);
      
      // Constrain offset
      const targetOffset = isOpen ? -100 : 0;
      const newOffset = Math.max(-MAX_OFFSET, Math.min(0, targetOffset + deltaX));
      setOffsetX(newOffset);
    }
    // If vertical, don't preventDefault - allow natural scrolling
  };

  const handleClick = () => {
    if (isOpen) {
      onClose();
    } else {
      onViewDetail();
    }
  };

  const handleTouchEnd = () => {
    if (!touchStart.current) return;
    
    if (isDragging && directionLocked.current === 'horizontal') {
      // Determine final state based on offset
      if (offsetX < -SWIPE_THRESHOLD) {
        onOpen();
        setOffsetX(-100);
      } else {
        onClose();
        setOffsetX(0);
      }
    }
    
    setIsDragging(false);
    directionLocked.current = null;
    touchStart.current = null;
  };

  // Sync offsetX with isOpen state
  useEffect(() => {
    setOffsetX(isOpen ? -100 : 0);
  }, [isOpen]);

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

  const nextReview = item.srs.nextReview;
  const isDue = nextReview <= Date.now();
  const intervalDays = Math.round(item.srs.interval / (24 * 60));

  return (
    <div className="relative overflow-hidden rounded-2xl shadow-sm border border-slate-100 bg-slate-50">
      {/* Action Buttons Background */}
      <div className="absolute top-0 right-0 bottom-0 w-[100px] flex items-center justify-around bg-gradient-to-l from-slate-200 to-slate-100">
        <button 
          onClick={(e) => { e.stopPropagation(); onSearch(title); onClose(); }}
          className="p-2 bg-white text-indigo-500 shadow rounded-full hover:bg-indigo-50 active:scale-90 transition-all"
          title="Refresh / Search Again"
        >
          <RefreshCw size={18} />
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); onDelete(item.data.id); }}
          className="p-2 bg-white text-rose-500 shadow rounded-full hover:bg-rose-50 active:scale-90 transition-all"
          title="Delete"
        >
          <Trash2 size={18} />
        </button>
      </div>

      {/* Main Card */}
      <div
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
        }}
        className="bg-white p-4 relative cursor-pointer"
      >
        {/* SRS Indicator Strip */}
        <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${isDue ? 'bg-orange-400' : (intervalDays > 21 ? 'bg-emerald-400' : 'bg-slate-200')}`}></div>

        <div className="flex items-start gap-3 pl-2">
          <div className={`mt-1 shrink-0 ${isPhrase ? 'text-indigo-400' : 'text-emerald-400'}`}>
            {isPhrase ? <Layers size={14} /> : <Type size={14} />}
          </div>
          
          <div className="min-w-0 flex-1 pt-0.5 pr-2">
            <div className="mb-2 min-w-0">
              <h4 className="font-bold text-slate-900 text-lg leading-tight line-clamp-2 text-ellipsis overflow-hidden" title={title}>{title}</h4>
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                {ipa && (
                  <div className="min-w-0 shrink-0 max-w-full">
                    <PronunciationBlock 
                      text={title} 
                      ipa={ipa} 
                      className="text-xs py-0.5 px-1.5 min-h-[24px] bg-slate-50 border border-slate-100 max-w-[180px]" 
                    />
                  </div>
                )}
                {sense && totalInGroup > 1 && (
                  <span className="text-[10px] font-medium text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full shrink-0 max-w-[120px] truncate" title={sense}>
                    {sense}
                  </span>
                )}
                {isDue && <span className="text-[10px] font-bold text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full uppercase tracking-wide shrink-0">Due</span>}
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
      </div>
    </div>
  );
};

// Carousel wrapper for grouped items with same spelling
interface NotebookGroupProps {
  group: ItemGroup;
  openItemId: string | null;
  setOpenItemId: (id: string | null) => void;
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: (groupItems: StoredItem[], index: number) => void;
}

const NotebookGroup: React.FC<NotebookGroupProps> = ({
  group, openItemId, setOpenItemId, onDelete, onSearch, onViewDetail
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const totalItems = group.items.length;
  
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
          onViewDetail(group.items, 0);
        }}
      />
    );
  }
  
  // Multiple items - carousel mode
  const currentItem = group.items[currentIndex];
  
  const goNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev + 1) % totalItems);
  };
  
  const goPrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev - 1 + totalItems) % totalItems);
  };
  
  return (
    <div className="relative">
      {/* Carousel indicator */}
      <div className="absolute -top-1 right-2 z-10 flex items-center gap-1 bg-violet-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm">
        <span>{currentIndex + 1}/{totalItems}</span>
        <span className="opacity-70">meanings</span>
      </div>
      
      {/* Navigation arrows */}
      <button
        onClick={goPrev}
        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 w-8 h-8 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center text-slate-500 hover:text-violet-600 hover:border-violet-300 transition-all active:scale-90"
      >
        <ChevronLeft size={18} />
      </button>
      <button
        onClick={goNext}
        className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10 w-8 h-8 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center text-slate-500 hover:text-violet-600 hover:border-violet-300 transition-all active:scale-90"
      >
        <ChevronRight size={18} />
      </button>
      
      {/* Card */}
      <div className="mx-4">
        <NotebookItem 
          item={currentItem}
          isOpen={openItemId === currentItem.data.id}
          onOpen={() => setOpenItemId(currentItem.data.id)}
          onClose={() => setOpenItemId(null)}
          onDelete={onDelete}
          onSearch={onSearch}
          onViewDetail={() => {
            setOpenItemId(null);
            onViewDetail(group.items, currentIndex);
          }}
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
  onViewDetail: (items: StoredItem[], index: number) => void;
  user: AppUser | null;
  onSignIn: () => void;
  onSignOut: () => void;
  syncStatus?: SyncStatus;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onForceSync?: () => void;
  isOnline?: boolean;
  onBulkRefresh?: () => void;
  bulkRefreshProgress?: { current: number; total: number; isRunning: boolean } | null;
}

export const NotebookView: React.FC<NotebookProps> = ({ 
    items, onDelete, onSearch, onViewDetail, 
    user, onSignIn, onSignOut, syncStatus, onScroll, onForceSync, isOnline = true,
    onBulkRefresh, bulkRefreshProgress
}) => {
  const [sortMode, setSortMode] = useState<'familiarity' | 'alphabetical'>('familiarity');
  const [filterMode, setFilterMode] = useState<'all' | 'vocab' | 'phrase'>('all');
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const lastScrollY = useRef(0);

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
  
  const { displayItems, groupedItems } = React.useMemo(() => {
    const filtered = items
      .filter(i => {
        const isValid = i && i.data && i.data.id && !i.isDeleted;
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

        const strengthA = a.srs?.memoryStrength || 0;
        const strengthB = b.srs?.memoryStrength || 0;
        
        if (strengthA !== strengthB) {
          return strengthA - strengthB;
        }

        return (b.savedAt || 0) - (a.savedAt || 0);
      });
    
    // Group items by title (same spelling)
    const groupMap = new Map<string, StoredItem[]>();
    filtered.forEach(item => {
      const title = item.type === 'phrase' 
        ? (item.data as any).query?.toLowerCase().trim()
        : (item.data as any).word?.toLowerCase().trim();
      
      if (!title) return;
      
      if (!groupMap.has(title)) {
        groupMap.set(title, []);
      }
      groupMap.get(title)!.push(item);
    });
    
    // Convert to array of groups, maintaining sort order of first item in each group
    const groups: ItemGroup[] = [];
    const seenTitles = new Set<string>();
    
    filtered.forEach(item => {
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
    
    return { displayItems: filtered, groupedItems: groups };
  }, [items, sortMode, filterMode]);

  if (displayItems.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50">
        <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
          <BookOpen size={32} className="text-indigo-300" />
        </div>
        <h3 className="text-xl font-bold text-slate-700 mb-2">Your notebook is empty</h3>
        <p className="text-sm mb-8 max-w-xs mx-auto">Save words and phrases from your searches to build your personalized learning library.</p>
        
        <div className="flex justify-center">
          <UserMenu 
            user={user} 
            onSignIn={onSignIn} 
            onSignOut={onSignOut} 
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-slate-50" onScroll={handleScroll}>
      {/* Header */}
      <div className={`sticky top-0 z-10 bg-slate-50/90 backdrop-blur-md px-6 py-4 border-b border-slate-200/50 flex justify-between items-center transition-transform duration-300 ${showHeader ? 'translate-y-0' : '-translate-y-full'}`}>
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
            title={sortMode === 'familiarity' ? 'Sort: Familiarity' : 'Sort: A-Z'}
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

      <div className="p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] grid gap-4 max-w-3xl mx-auto">
        {groupedItems.map((group) => (
          <NotebookGroup
            key={group.title}
            group={group}
            openItemId={openItemId}
            setOpenItemId={setOpenItemId}
            onDelete={onDelete}
            onSearch={onSearch}
            onViewDetail={(groupItems, index) => {
              // Pass the group items directly for carousel navigation in DetailView
              onViewDetail(groupItems, index);
            }}
          />
        ))}
      </div>
    </div>
  );
};
