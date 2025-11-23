
import React, { useState, useRef } from 'react';
import { VocabCard, SearchResult, StoredItem } from '../types';
import { ArrowLeft, Bookmark, BookmarkMinus, Play, Search as SearchIcon } from 'lucide-react';
import { Button } from '../components/Button';
import { AudioButton } from '../components/AudioButton';
import { VocabCardDisplay } from '../components/VocabCard';
import ReactMarkdown from 'react-markdown';
import { SRSAlgorithm } from '../services/srsAlgorithm';

interface DetailViewProps {
  data: VocabCard | SearchResult;
  type: 'vocab' | 'phrase';
  onClose: () => void;
  onSave: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  savedItems: StoredItem[];
  onSearch: (text: string) => void;
}

// Helper to match title safely
const getStoredTitle = (item: StoredItem) => {
    if (!item || !item.data) return '';
    const data = item.data as any;
    const title = item.type === 'phrase' ? data.query : data.word;
    return String(title || '');
};

const createInitialSRS = (id: string, type: 'vocab' | 'phrase') => SRSAlgorithm.createNew(id, type);

export const DetailView: React.FC<DetailViewProps> = ({ 
  data, 
  type, 
  onClose, 
  onSave, 
  onDelete, 
  savedItems,
  onSearch
}) => {
  
  const title = type === 'phrase' ? (data as SearchResult).query : (data as VocabCard).word;
  
  // Check if this specific item is saved
  const savedItemMatch = savedItems.find(item => 
      getStoredTitle(item).toLowerCase().trim() === (title || '').toLowerCase().trim()
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
              srs: createInitialSRS(data.id, type)
          });
      }
  };

  const handleVocabSearch = (term: string) => {
      onClose();
      onSearch(term);
  };

  const handleSaveVocab = (vocab: VocabCard) => {
    // Check if already saved
    const isAlreadySaved = savedItems.some(i => 
        getStoredTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim()
    );

    if (isAlreadySaved) {
        // Find the ID and delete
        const existingItem = savedItems.find(i => 
            getStoredTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim()
        );
        if (existingItem) {
            onDelete(existingItem.data.id);
        }
    } else {
        // Save new
        onSave({
            data: vocab,
            type: 'vocab',
            savedAt: Date.now(),
            srs: createInitialSRS(vocab.id, 'vocab')
        });
    }
  };

  // Swipe to Close Logic
  const touchStart = useRef<number | null>(null);
  const touchEnd = useRef<number | null>(null);
  const minSwipeDistance = 50;

  const onTouchStart = (e: React.TouchEvent) => {
    touchEnd.current = null;
    touchStart.current = e.targetTouches[0].clientX;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    touchEnd.current = e.targetTouches[0].clientX;
  };

  const onTouchEnd = () => {
    if (!touchStart.current || !touchEnd.current) return;
    const distance = touchStart.current - touchEnd.current;
    const isRightSwipe = distance < -minSwipeDistance;
    
    // Swipe Right (Left -> Right) to go Back
    if (isRightSwipe) {
        onClose();
    }
  };

  return (
    <div 
        className="fixed inset-0 z-50 bg-slate-50 flex flex-col animate-in slide-in-from-right duration-300 shadow-2xl"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
    >
        {/* Header */}
        <div className="bg-white/80 backdrop-blur-md border-b border-slate-200/60 px-4 py-3 flex justify-between items-center shrink-0 z-30 sticky top-0">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-slate-600 -ml-2 hover:bg-slate-100/50">
                <ArrowLeft size={20} className="mr-1" /> Back
            </Button>
            <div className="flex items-center gap-2">
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

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto no-scrollbar p-4 pb-24">
            
            {/* VOCAB VIEW */}
            {type === 'vocab' && (
                 <VocabCardDisplay 
                    data={data as VocabCard}
                    isSaved={isSaved}
                    onSave={handleToggleSave}
                    showSave={false} // Handled in header
                    onExpand={undefined} // Already expanded
                    onSearch={handleVocabSearch}
                    scrollable={false} // Let the page scroll
                    className="min-h-full shadow-none border-0 !p-0 bg-transparent !h-auto !overflow-visible max-w-3xl mx-auto"
                 />
            )}

            {/* PHRASE VIEW */}
            {type === 'phrase' && (
                <div className="space-y-6 max-w-3xl mx-auto">
                    <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
                        {/* Hero Image */}
                        <div className="aspect-video bg-slate-100 relative overflow-hidden flex items-center justify-center group">
                            {(data as SearchResult).imageUrl ? (
                                <img src={(data as SearchResult).imageUrl} alt="Visual context" className="w-full h-full object-cover fade-in transition-transform duration-700 group-hover:scale-105" />
                            ) : (
                                <div className="flex flex-col items-center text-slate-400">
                                    <SearchIcon className="mb-2 opacity-30" size={32}/>
                                    <span className="text-xs uppercase font-bold tracking-wider opacity-60">{(data as SearchResult).visualKeyword}</span>
                                </div>
                            )}
                            <div className="absolute bottom-4 right-4">
                                <AudioButton 
                                    text={(data as SearchResult).query} 
                                    className="bg-white/90 backdrop-blur p-4 rounded-full shadow-lg text-indigo-600 active:scale-90 transition-all hover:bg-indigo-600 hover:text-white"
                                    initialIcon={Play}
                                    fillIcon={true}
                                    iconSize={24}
                                />
                            </div>
                        </div>

                        <div className="p-6 sm:p-8">
                            <div className="mb-6">
                                <h2 className="text-3xl font-bold text-slate-900 leading-tight mb-2">{(data as SearchResult).translation}</h2>
                                <p className="text-slate-500 font-mono text-base bg-slate-100 px-2 py-1 rounded-lg inline-block">{(data as SearchResult).pronunciation}</p>
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

                    {/* Included Vocab List */}
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
                                        isSaved={savedItems.some(i => getStoredTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim())}
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
        </div>
    </div>
  );
};
