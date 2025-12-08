import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StoredItem, SyncStatus, AppUser, ItemGroup } from '../types';
import { Trash2, BookOpen, Layers, Loader2, RefreshCw, Type, ArrowDownAZ, Sparkles, Filter, WifiOff, ChevronLeft, ChevronRight, RotateCcw, Archive, ArchiveRestore, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../components/Button';
import { UserMenu } from '../components/UserMenu';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { useWheelNavigation } from '../hooks';

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
}

export const NotebookView: React.FC<NotebookProps> = ({ 
    items, onDelete, onSearch, onViewDetail, 
    user, onSignIn, onSignOut, syncStatus, onScroll, onForceSync, isOnline = true,
    onBulkRefresh, bulkRefreshProgress, onArchive, onUnarchive
}) => {
  const [sortMode, setSortMode] = useState<'familiarity' | 'alphabetical'>('familiarity');
  const [filterMode, setFilterMode] = useState<'all' | 'vocab' | 'phrase'>('vocab'); // Default to vocab only
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
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
  
  const { displayItems, groupedItems, archivedItems, archivedGroups } = React.useMemo(() => {
    // Separate active and archived items
    const activeFiltered = items
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

        const strengthA = a.srs?.memoryStrength || 0;
        const strengthB = b.srs?.memoryStrength || 0;
        
        if (strengthA !== strengthB) {
          return strengthA - strengthB;
        }

        return (b.savedAt || 0) - (a.savedAt || 0);
      });
    
    // Archived items
    const archivedFiltered = items
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
    
    return { 
      displayItems: activeFiltered, 
      groupedItems: groupByTitle(activeFiltered),
      archivedItems: archivedFiltered,
      archivedGroups: groupByTitle(archivedFiltered)
    };
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

      <div className="px-3 pb-[calc(5rem+env(safe-area-inset-bottom))] grid gap-3 w-full max-w-screen-md mx-auto">
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
