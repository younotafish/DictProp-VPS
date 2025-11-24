
import React, { useState, useRef, useEffect } from 'react';
import { StoredItem, SyncStatus } from '../types';
import { Trash2, Search, BookOpen, Layers, Cloud, AlertCircle, Check, Loader2, RefreshCw, ChevronDown, ChevronUp, Type, ArrowDownAZ, Sparkles } from 'lucide-react';
import { Button } from '../components/Button';
import { UserMenu } from '../components/UserMenu';
import { PronunciationBlock } from '../components/PronunciationBlock';

interface NotebookItemProps {
  item: StoredItem;
  index: number;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: () => void;
}

const NotebookItem: React.FC<NotebookItemProps> = ({
  item, isOpen, onOpen, onClose, onDelete, onSearch, onViewDetail
}) => {
  const touchStart = useRef<{x: number, y: number, time: number} | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  
  const SWIPE_THRESHOLD = 60;
  const MAX_OFFSET = 100;
  
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      time: Date.now()
    };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current) return;

    const deltaX = e.touches[0].clientX - touchStart.current.x;
    const deltaY = e.touches[0].clientY - touchStart.current.y;

    // Only drag if horizontal movement is dominant
    if (Math.abs(deltaX) > Math.abs(deltaY) * 2) {
      e.preventDefault();
      setIsDragging(true);
      
      // Constrain offset
      const targetOffset = isOpen ? -100 : 0;
      const newOffset = Math.max(-MAX_OFFSET, Math.min(0, targetOffset + deltaX));
      setOffsetX(newOffset);
    }
  };

  const handleTouchEnd = () => {
    if (!touchStart.current) return;
    
    if (isDragging) {
      // Determine final state based on offset
      if (offsetX < -SWIPE_THRESHOLD) {
        onOpen();
        setOffsetX(-100);
      } else {
        onClose();
        setOffsetX(0);
      }
    } else {
      // It was a tap, not a drag
      if (isOpen) {
        onClose();
      } else {
        onViewDetail();
      }
    }
    
    setIsDragging(false);
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
              <h4 className="font-bold text-slate-900 text-lg leading-tight truncate max-w-full">{title}</h4>
              {ipa && <PronunciationBlock text={title} ipa={ipa} className="text-xs py-0.5 px-1.5 h-6 bg-slate-50 border border-slate-100 max-w-[120px] shrink-0" />}
              {isDue && <span className="text-[10px] font-bold text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full uppercase tracking-wide shrink-0">Due</span>}
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

interface NotebookProps {
  items: StoredItem[];
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: (items: StoredItem[], index: number) => void;
  user: any | null;
  onSignIn: () => void;
  onGuestSignIn?: () => void;
  onSignOut: () => void;
  isConfigured: boolean;
  syncStatus?: SyncStatus;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onForceSync?: () => void;
}

export const NotebookView: React.FC<NotebookProps> = ({ 
    items, onDelete, onSearch, onViewDetail, 
    user, onSignIn, onGuestSignIn, onSignOut, isConfigured, syncStatus, onScroll, onForceSync
}) => {
  const [sortMode, setSortMode] = useState<'familiarity' | 'alphabetical'>('familiarity');
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
  
  const displayItems = React.useMemo(() => {
    return items
      .filter(i => i && i.data && i.data.id && !i.isDeleted)
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
  }, [items, sortMode]);

  if (displayItems.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50">
        <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
          <BookOpen size={32} className="text-indigo-300" />
        </div>
        <h3 className="text-xl font-bold text-slate-700 mb-2">Your notebook is empty</h3>
        <p className="text-sm mb-8 max-w-xs mx-auto">Save words from your searches to build your personal library.</p>
        
        <div className="flex justify-center">
          <UserMenu 
            user={user} 
            onSignIn={onSignIn} 
            onGuestSignIn={onGuestSignIn}
            onSignOut={onSignOut} 
            isConfigured={isConfigured} 
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
          <p className="text-xs text-slate-500 font-medium">{displayItems.length} items stored</p>
        </div>
        <div className="flex items-center gap-1 bg-white rounded-full p-1 pl-1 border border-slate-100 shadow-sm">
          <button
            onClick={() => setSortMode(prev => prev === 'familiarity' ? 'alphabetical' : 'familiarity')}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-50 text-slate-400 hover:text-indigo-600 transition-colors"
            title={sortMode === 'familiarity' ? 'Sort: Familiarity' : 'Sort: A-Z'}
          >
            {sortMode === 'familiarity' ? <Sparkles size={16} /> : <ArrowDownAZ size={16} />}
          </button>
          <div className="h-4 w-[1px] bg-slate-200 mx-1"></div>
          <div className="mr-2 flex items-center gap-2" title={`Sync Status: ${syncStatus}`}>
            <button 
              onClick={onForceSync} 
              disabled={syncStatus === 'syncing' || !user}
              className={`flex items-center gap-2 group ${syncStatus === 'syncing' ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-slate-50 rounded-full pr-2'}`}
              title="Force Sync (Download & Upload)"
            >
              <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider hidden sm:inline group-hover:text-slate-600">Sync</span>
              {syncStatus === 'syncing' ? (
                <Loader2 className="animate-spin text-indigo-500" size={16} />
              ) : (
                <RefreshCw className="text-slate-400 group-hover:text-indigo-500 transition-colors" size={14} />
              )}
            </button>
          </div>
          <div className="h-4 w-[1px] bg-slate-200 mx-1"></div>
          <UserMenu 
            user={user} 
            onSignIn={onSignIn} 
            onGuestSignIn={onGuestSignIn}
            onSignOut={onSignOut} 
            isConfigured={isConfigured} 
          />
        </div>
      </div>

      <div className="p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] grid gap-3 max-w-3xl mx-auto">
        {displayItems.map((item, index) => (
          <NotebookItem 
            key={item.data.id}
            item={item}
            index={index}
            isOpen={openItemId === item.data.id}
            onOpen={() => setOpenItemId(item.data.id)}
            onClose={() => setOpenItemId(null)}
            onDelete={onDelete}
            onSearch={onSearch}
            onViewDetail={() => {
              setOpenItemId(null);
              onViewDetail(displayItems, index);
            }}
          />
        ))}
      </div>
    </div>
  );
};
