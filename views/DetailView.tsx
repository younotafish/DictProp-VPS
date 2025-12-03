import React, { useState, useRef } from 'react';
import { VocabCard, SearchResult, StoredItem, getItemTitle } from '../types';
import { ArrowLeft, Bookmark, BookmarkMinus, Search as SearchIcon, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../components/Button';
import { VocabCardDisplay } from '../components/VocabCard';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { OfflineImage } from '../components/OfflineImage';
import ReactMarkdown from 'react-markdown';
import { SRSAlgorithm } from '../services/srsAlgorithm';

interface DetailViewProps {
  items?: StoredItem[];
  initialIndex?: number;
  
  // Legacy single item mode (for Search view)
  data?: VocabCard | SearchResult;
  type?: 'vocab' | 'phrase';
  
  onClose: () => void;
  onSave: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  savedItems: StoredItem[];
  onSearch: (text: string) => void;
}

export const DetailView: React.FC<DetailViewProps> = ({ 
  items,
  initialIndex = 0,
  data: initialData,
  type: initialType,
  onClose, 
  onSave, 
  onDelete, 
  savedItems,
  onSearch
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showHeader, setShowHeader] = useState(true);
  const lastScrollY = useRef(0);
  
  // Determine current item to display
  const currentItem = items ? items[currentIndex] : (initialData && initialType ? { data: initialData, type: initialType } : null);
  
  if (!currentItem) {
    return null;
  }
  
  const data = currentItem.data;
  const type = currentItem.type;
  
  const nextIndex = currentIndex + 1;
  const prevIndex = currentIndex - 1;
  const hasNext = items && nextIndex < items.length;
  const hasPrev = items && prevIndex >= 0;

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const currentScrollY = target.scrollTop;

    // Header auto-hide logic
    if (currentScrollY < 50) {
      if (!showHeader) setShowHeader(true);
    } else if (Math.abs(currentScrollY - lastScrollY.current) > 10) {
      setShowHeader(currentScrollY < lastScrollY.current);
    }
    
    lastScrollY.current = currentScrollY;
  };
  
  // Touch Handling for horizontal swipe navigation between items
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  
  const onContentTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };
  
  const onContentTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null || !items || isAnimating) return;
    
    const diffX = e.changedTouches[0].clientX - touchStartX.current;
    const diffY = e.changedTouches[0].clientY - touchStartY.current;
    
    // Only handle horizontal swipes (more horizontal than vertical)
    if (Math.abs(diffX) > Math.abs(diffY) * 1.5 && Math.abs(diffX) > 50) {
      // Swipe LEFT (diffX < 0) -> Next Item
      if (diffX < -50 && hasNext) {
        setIsAnimating(true);
        setCurrentIndex(nextIndex);
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setTimeout(() => setIsAnimating(false), 300);
      }
      
      // Swipe RIGHT (diffX > 0) -> Prev Item (or close if no prev)
      if (diffX > 50) {
        if (hasPrev) {
          setIsAnimating(true);
          setCurrentIndex(prevIndex);
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
  
  const savedItemMatch = savedItems.find(item => 
    getItemTitle(item).toLowerCase().trim() === (title || '').toLowerCase().trim()
  );
  const isSaved = !!savedItemMatch;

  const handleToggleSave = () => {
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
  };

  const handleVocabSearch = (term: string) => {
    onClose();
    onSearch(term);
  };

  const handleSaveVocab = (vocab: VocabCard) => {
    const isAlreadySaved = savedItems.some(i => 
      getItemTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim()
    );

    if (isAlreadySaved) {
      const existingItem = savedItems.find(i => 
        getItemTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim()
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
      >
        {/* Header */}
        <div className={`sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200/60 px-4 py-3 flex justify-between items-center shrink-0 transition-transform duration-300 ${showHeader ? 'translate-y-0' : '-translate-y-full'}`}>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-slate-600 -ml-2 hover:bg-slate-100/50">
            <ArrowLeft size={20} className="mr-1" /> Back
          </Button>
          <div className="flex items-center gap-2">
            {/* Horizontal navigation for carousel */}
            {items && items.length > 1 && (
              <>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => { 
                    if (hasPrev) {
                      setCurrentIndex(prevIndex); 
                      if(scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0; 
                    }
                  }}
                  disabled={!hasPrev}
                  className={`p-1.5 ${hasPrev ? 'text-slate-500 hover:text-indigo-600' : 'text-slate-300 cursor-not-allowed'}`}
                >
                  <ChevronLeft size={20} />
                </Button>
                <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2 py-1 rounded-full min-w-[50px] text-center">
                  {currentIndex + 1} / {items.length}
                </span>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => { 
                    if (hasNext) {
                      setCurrentIndex(nextIndex); 
                      if(scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0; 
                    }
                  }}
                  disabled={!hasNext}
                  className={`p-1.5 ${hasNext ? 'text-slate-500 hover:text-indigo-600' : 'text-slate-300 cursor-not-allowed'}`}
                >
                  <ChevronRight size={20} />
                </Button>
                <div className="w-[1px] h-4 bg-slate-300 mx-1"></div>
              </>
            )}
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => onSearch(type === 'phrase' ? (data as SearchResult).query : (data as VocabCard).word)}
              className="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
              title="Refresh / Search Again"
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
          </div>
        </div>

        <div className="p-4 pb-24">
          {/* Sense badge for multi-meaning words */}
          {items && items.length > 1 && type === 'vocab' && (data as VocabCard).sense && (
            <div className="mb-4 flex items-center justify-center">
              <span className="text-sm font-medium text-violet-600 bg-violet-50 px-4 py-1.5 rounded-full border border-violet-100">
                {(data as VocabCard).sense}
              </span>
            </div>
          )}

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
                <div className="aspect-video bg-slate-100 relative overflow-hidden flex items-center justify-center group">
                  {(data as SearchResult).imageUrl ? (
                    <OfflineImage src={(data as SearchResult).imageUrl} alt="Visual context" className="w-full h-full object-cover fade-in transition-transform duration-700 group-hover:scale-105" />
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
                        isSaved={savedItems.some(i => getItemTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim())}
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

          {/* Horizontal swipe hint for multi-meaning words */}
          {items && items.length > 1 && (
            <div className="py-6 text-center text-slate-400 flex items-center justify-center gap-3">
              {hasPrev && (
                <div className="flex items-center gap-1 opacity-60">
                  <ChevronLeft size={14} />
                  <span className="text-[10px] uppercase font-bold tracking-wider">Prev meaning</span>
                </div>
              )}
              {hasPrev && hasNext && <span className="text-slate-300">•</span>}
              {hasNext && (
                <div className="flex items-center gap-1 opacity-60">
                  <span className="text-[10px] uppercase font-bold tracking-wider">Next meaning</span>
                  <ChevronRight size={14} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
