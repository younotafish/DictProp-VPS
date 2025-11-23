
import React, { useState, useEffect, useRef } from 'react';
import { analyzeInput, generateIllustration } from '../services/geminiService';
import { SearchResult, StoredItem, VocabCard } from '../types';
import { ArrowRight, Search as SearchIcon, Mic, Loader2, Bookmark, BookmarkMinus, Play, RotateCw, BookOpen, ArrowLeft } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Button } from '../components/Button';
import { VocabCardDisplay } from '../components/VocabCard';
import { AudioButton } from '../components/AudioButton';

interface SearchProps {
  onSave: (item: StoredItem) => void;
  onUpdateStoredItem: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  savedItems: StoredItem[];
  initialQuery?: string;
  initialData?: StoredItem;
  onViewDetail?: (data: VocabCard | SearchResult, type: 'vocab' | 'phrase') => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

// Helper to match title safely
const getStoredTitle = (item: StoredItem) => {
    if (!item || !item.data) return '';
    const data = item.data as any;
    const title = item.type === 'phrase' ? data.query : data.word;
    return String(title || '');
};

export const SearchView: React.FC<SearchProps> = ({ onSave, onUpdateStoredItem, onDelete, savedItems, initialQuery, initialData, onViewDetail, onScroll }) => {
  const [query, setQuery] = useState(initialQuery || '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [vocabResult, setVocabResult] = useState<VocabCard | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isViewingStored, setIsViewingStored] = useState(false);
  const [searchHistory, setSearchHistory] = useState<Array<{query: string, result: SearchResult | VocabCard, type: 'phrase' | 'vocab'}>>([]);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMounted = useRef(true);

  useEffect(() => {
      isMounted.current = true;
      return () => { isMounted.current = false; };
  }, []);

  // Determine title of current view
  const currentTitle = vocabResult 
    ? (vocabResult.word || '')
    : result 
        ? (result.query || '') 
        : '';

  // Find if this title exists in saved items (Case-insensitive check)
  const savedItemMatch = currentTitle 
    ? savedItems.find(item => getStoredTitle(item).toLowerCase().trim() === currentTitle.toLowerCase().trim())
    : undefined;

  const isSaved = !!savedItemMatch;
  
  // Handle Initial Data (From Notebook)
  useEffect(() => {
    if (initialData) {
        setIsViewingStored(true);
        setLoading(false);
        setError(null);
        setResult(null);
        setVocabResult(null);

        if (initialData.type === 'phrase') {
            const data = initialData.data as SearchResult;
            setResult(data);
            setQuery(data.query);
        } else {
            const data = initialData.data as VocabCard;
            setVocabResult(data);
            setQuery(data.word);
        }
    }
  }, [initialData]);

  // Handle Initial Query (Recursive search)
  useEffect(() => {
    if (initialQuery && initialQuery !== result?.query && initialQuery !== vocabResult?.word) {
        setIsViewingStored(false);
        setVocabResult(null);
        setQuery(initialQuery);
        // Trigger search immediately
        performSearch(initialQuery);
    }
  }, [initialQuery]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [query]);

  const handleBack = () => {
    if (searchHistory.length > 0) {
      const previous = searchHistory[searchHistory.length - 1];
      setSearchHistory(prev => prev.slice(0, -1));
      
      if (previous.type === 'phrase') {
        setResult(previous.result as SearchResult);
        setVocabResult(null);
      } else {
        setVocabResult(previous.result as VocabCard);
        setResult(null);
      }
      setQuery(previous.query);
    }
  };

  const performSearch = async (text: string) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setVocabResult(null);
    try {
        const data = await analyzeInput(text);
        if (!isMounted.current) return;

        setResult(data);
        setLoading(false);
        setImageLoading(true);
        
        // 1. Generate Main Visual Context
        generateIllustration(data.visualKeyword, '16:9').then(img => {
             if (!isMounted.current) return;
             if (img) {
                 setResult(prev => prev ? { ...prev, imageUrl: img } : null);
                 
                 // Update storage if this item is already saved
                 const updatedData = { ...data, imageUrl: img };
                 onUpdateStoredItem({
                     data: updatedData,
                     type: 'phrase',
                     savedAt: 0, 
                     srs: { id: data.id, type: 'phrase', nextReview: 0, interval: 0, easeFactor: 0, history: [] }
                 });
             }
             setImageLoading(false);
        });

        // 2. Generate Vocab Illustrations (Parallel)
        data.vocabs.forEach(vocab => {
            if (vocab.imagePrompt) {
                generateIllustration(vocab.imagePrompt, '4:3').then(img => {
                    if (!isMounted.current) return;
                    if (img) {
                         const updatedVocab = { ...vocab, imageUrl: img };
                         
                         setResult(prev => {
                             if (!prev) return null;
                             const newVocabs = (prev.vocabs || []).map(v => 
                                v.id === vocab.id ? { ...v, imageUrl: img } : v
                             );
                             return { ...prev, vocabs: newVocabs };
                         });

                         // Update storage if this vocab (or its parent phrase) is already saved
                         onUpdateStoredItem({
                             data: updatedVocab,
                             type: 'vocab',
                             savedAt: 0,
                             srs: { id: vocab.id, type: 'vocab', nextReview: 0, interval: 0, easeFactor: 0, history: [] }
                         });
                    }
                });
            }
        });

    } catch (err: any) {
        if (isMounted.current) {
            if (err.message === 'QUOTA_EXCEEDED') {
                 setError("Daily AI limit reached. Please check your plan or try again later.");
            } else {
                 setError("Search failed. Please try again.");
            }
            setLoading(false);
        }
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim() || loading) return;
    setIsViewingStored(false);
    performSearch(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleRefresh = () => {
      setIsViewingStored(false);
      performSearch(query);
  };

  const handleNewSearch = () => {
    // Clear query but keep results visible
    setQuery('');
    setError(null);
    setIsViewingStored(false);
    // Note: Don't clear result/vocabResult to preserve last search
    // Note: textarea height reset is handled by the useEffect reacting to query change
  };

  const handleTermClick = (term: string) => {
      setQuery(term);
      setIsViewingStored(false);
      performSearch(term);
  };

  const toggleSave = () => {
    if (vocabResult) {
        toggleSaveVocab(vocabResult);
        return;
    }

    if (!result) return;
    
    if (isSaved && savedItemMatch) {
      // Safely delete using the ID of the STORED item
      if (savedItemMatch.data && savedItemMatch.data.id) {
          onDelete(savedItemMatch.data.id);
      }
    } else {
      if (!result.id) return; // Sanity check
      
      onSave({
        data: result,
        type: 'phrase',
        savedAt: Date.now(),
        srs: {
          id: result.id,
          type: 'phrase',
          nextReview: Date.now(),
          interval: 0,
          easeFactor: 2.5,
          history: []
        }
      });
    }
  };

  const toggleSaveVocab = (vocab: VocabCard) => {
    // Ensure vocab word exists to prevent crash
    const word = vocab.word || '';
    if (!word) return;

    // Check specifically for this vocab word in storage
    const savedVocabMatch = savedItems.find(item => 
        getStoredTitle(item).toLowerCase().trim() === word.toLowerCase().trim()
    );

    if (savedVocabMatch) {
        if (savedVocabMatch.data && savedVocabMatch.data.id) {
            onDelete(savedVocabMatch.data.id);
        }
    } else {
        if (!vocab.id) return;

        onSave({
            data: vocab,
            type: 'vocab',
            savedAt: Date.now(),
            srs: {
                id: vocab.id,
                type: 'vocab',
                nextReview: Date.now(),
                interval: 0,
                easeFactor: 2.5,
                history: []
            }
        });
    }
  };

  const headerTitle = vocabResult ? (vocabResult.word || '') : result ? (result.query || '') : '';

  return (
    <div className="h-full flex flex-col bg-slate-50 relative">
      
      {/* Top Search Input Area */}
      <div className="w-full p-3 bg-white/80 backdrop-blur-md border-b border-slate-200/60 z-30 sticky top-0 shrink-0">
        <div className="flex items-center gap-2 max-w-3xl mx-auto">
          {searchHistory.length > 0 && (result || vocabResult) && (
            <button
              onClick={handleBack}
              className="p-3 hover:bg-slate-100 rounded-xl transition-colors shrink-0 text-slate-500 hover:text-slate-700"
              title="Back"
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <form onSubmit={handleSubmit} className="relative shadow-sm rounded-2xl bg-slate-100 focus-within:ring-2 ring-indigo-500/20 focus-within:bg-white transition-all border border-transparent focus-within:border-indigo-200 flex-1">
          <textarea
            ref={textareaRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            placeholder="What do you want to learn?"
            rows={1}
            className="w-full pl-4 pr-12 py-3.5 text-base rounded-2xl bg-transparent text-slate-800 placeholder:text-slate-400 outline-none resize-none overflow-hidden disabled:opacity-60"
            style={{ minHeight: '52px' }}
          />
          <button 
            type="submit"
            disabled={!query.trim() || loading}
            className="absolute right-2 bottom-2 w-9 h-9 bg-indigo-600 text-white rounded-xl flex items-center justify-center hover:bg-indigo-700 disabled:opacity-0 disabled:scale-90 transition-all shadow-md shadow-indigo-200 hidden sm:flex"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={20} />}
          </button>
        </form>
        </div>
      </div>
      
      {/* Content Area - Scrollable */}
      <div className="flex-1 overflow-y-auto w-full min-h-0 pb-[calc(5rem+env(safe-area-inset-bottom))]" onScroll={onScroll}>
        
        {/* Zero State - Centered in available space */}
        {!result && !vocabResult && !loading && !error && (
          <div className="flex flex-col items-center justify-center min-h-[70vh] px-6 text-center fade-in">
            <div className="relative mb-8 group">
                <div className="absolute inset-0 bg-indigo-500 rounded-3xl blur-2xl opacity-20 group-hover:opacity-30 transition-opacity duration-500"></div>
                <div className="w-24 h-24 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-3xl flex items-center justify-center text-white shadow-xl shadow-indigo-200 relative z-10 transform transition-transform duration-500 hover:rotate-3 hover:scale-105">
                    <SearchIcon size={48} strokeWidth={2.5} />
                </div>
            </div>
            
            <h1 className="text-3xl font-bold text-slate-900 mb-3 tracking-tight">
              What's on your mind?
            </h1>
            <p className="text-slate-500 max-w-xs mb-10 text-lg leading-relaxed">
              Ask about any phrase, idiom, or word to get an AI-powered explanation.
            </p>
            
            <div className="w-full max-w-md space-y-4">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Inspiration</p>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                    { t: "serendipity", i: "📚" },
                    { t: "break the ice", i: "💬" },
                    { t: "ephemeral", i: "⏰" },
                    { t: "hit the nail on the head", i: "🎯" }
                ].map((item) => (
                    <button 
                        key={item.t}
                        onClick={() => { setQuery(item.t); performSearch(item.t); }}
                        className="bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50 transition-all active:scale-95 shadow-sm"
                    >
                        <span className="mr-2 opacity-80">{item.i}</span> {item.t}
                    </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Loading State - Centered */}
        {loading && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] fade-in">
            <div className="relative">
                <div className="absolute inset-0 bg-indigo-500 blur-xl opacity-20 animate-pulse"></div>
                <Loader2 className="animate-spin text-indigo-600 mb-6 relative z-10" size={48} />
            </div>
            <p className="text-slate-500 font-medium animate-pulse text-lg">Analyzing nuances...</p>
          </div>
        )}

        {/* Error State */}
        {error && (
            <div className="p-6 mx-4 mt-10 text-center bg-red-50 rounded-2xl border border-red-100 flex flex-col items-center animate-in slide-in-from-bottom-4">
                <div className="w-12 h-12 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-3">
                    <AlertCircle size={24} />
                </div>
                <h3 className="font-bold text-slate-800 mb-1">Something went wrong</h3>
                <p className="text-sm text-slate-600 mb-4">{error}</p>
                <Button variant="secondary" size="sm" className="text-red-600 hover:bg-red-100 border-red-200" onClick={handleNewSearch}>
                    Try Again
                </Button>
            </div>
        )}

        {/* Result Display */}
        {(result || vocabResult) && !loading && (
          <div className="fade-in pb-8 max-w-3xl mx-auto">
            
            {/* Sticky Context Header (Floating) */}
            <div className="sticky top-0 z-20 px-4 py-3 pointer-events-none">
                <div className="bg-white/90 backdrop-blur-md border border-slate-200/60 rounded-2xl px-4 py-2.5 flex justify-between items-center shadow-sm pointer-events-auto">
                    <h2 className="font-bold text-slate-800 truncate max-w-[60%] text-sm flex items-center gap-2">
                        {result && <span className="w-2 h-2 rounded-full bg-indigo-500"></span>}
                        {vocabResult && <span className="w-2 h-2 rounded-full bg-emerald-500"></span>}
                        {headerTitle}
                    </h2>
                    <div className="flex items-center gap-1">
                        {isViewingStored && (
                            <Button variant="ghost" size="sm" onClick={handleRefresh} title="Refresh Analysis" className="h-8 w-8 p-0">
                                <RotateCw size={16} className="text-slate-400" />
                            </Button>
                        )}
                        <Button 
                            variant="ghost" 
                            size="sm" 
                            onClick={toggleSave} 
                            className={`h-8 px-3 gap-1.5 rounded-lg border ${isSaved ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'border-transparent text-slate-500 hover:bg-slate-100'}`}
                        >
                            {isSaved ? <BookmarkMinus size={16} /> : <Bookmark size={16} />}
                            <span className="text-xs font-bold">{isSaved ? 'Saved' : 'Save'}</span>
                        </Button>
                    </div>
                </div>
            </div>

            {/* Render Search Result (Phrase) */}
            {result && (
                <>
                {/* Hero Card */}
                <div className="px-4 space-y-4 mt-2">
                <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
                    {/* Generated Image Header */}
                    <div className="aspect-video bg-slate-100 relative overflow-hidden flex items-center justify-center group">
                    {result.imageUrl ? (
                        <img src={result.imageUrl} alt="Visual context" className="w-full h-full object-cover fade-in transition-transform duration-700 group-hover:scale-105" />
                    ) : (
                        <div className="flex flex-col items-center text-slate-400">
                            {imageLoading ? <Loader2 className="animate-spin mb-2 text-indigo-400"/> : <SearchIcon className="mb-2 opacity-30" size={32}/>}
                            <span className="text-xs uppercase font-bold tracking-wider opacity-60">{result.visualKeyword || 'Generating Visual...'}</span>
                        </div>
                    )}
                    <div className="absolute bottom-4 right-4">
                        <AudioButton 
                            text={result.query} 
                            className="bg-white/90 backdrop-blur p-4 rounded-full shadow-lg text-indigo-600 active:scale-90 transition-all hover:bg-indigo-600 hover:text-white"
                            initialIcon={Play}
                            fillIcon={true}
                            iconSize={24}
                        />
                    </div>
                    </div>

                    <div className="p-6 sm:p-8">
                        <div className="mb-6">
                            <h2 className="text-3xl font-bold text-slate-900 leading-tight mb-2">{result.translation}</h2>
                            <p className="text-slate-500 font-mono text-base bg-slate-100 px-2 py-1 rounded-lg inline-block">{result.pronunciation}</p>
                        </div>
                        
                        <div className="prose prose-indigo prose-sm sm:prose-base max-w-none text-slate-600">
                            <ReactMarkdown 
                                components={{
                                    strong: ({node, ...props}) => <span className="font-bold text-indigo-700 bg-indigo-50 px-1 rounded" {...props} />
                                }}
                            >
                                {result.grammar}
                            </ReactMarkdown>
                        </div>
                    </div>
                </div>
                </div>

                {/* Vocab Carousel */}
                {(result.vocabs || []).length > 0 && (
                    <div className="mt-8 mb-6">
                        <div className="px-6 mb-4 flex items-center gap-2">
                            <BookOpen size={16} className="text-indigo-500" />
                            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Key Vocabulary</h3>
                        </div>
                        <div className="flex overflow-x-auto px-4 gap-4 pb-8 no-scrollbar snap-x snap-mandatory items-stretch">
                            {(result.vocabs || []).map((vocab) => (
                                <div key={vocab.id} className="min-w-[85vw] md:min-w-[400px] snap-center h-auto">
                                    <VocabCardDisplay 
                                        data={vocab} 
                                        onSave={() => toggleSaveVocab(vocab)}
                                        isSaved={savedItems.some(i => getStoredTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim())}
                                        onSearch={handleTermClick}
                                        onExpand={() => onViewDetail?.(vocab, 'vocab')}
                                        scrollable={false}
                                        className="h-full border-slate-200 shadow-sm hover:shadow-md transition-shadow"
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                </>
            )}

            {/* Render Single Vocab Card (Stored Vocab) */}
            {vocabResult && (
                <div className="p-4 h-full pb-10 mt-2">
                     <div className="flex items-center gap-2 mb-4 px-2 text-slate-400 text-xs uppercase font-bold tracking-wider">
                        <BookOpen size={14} />
                        <span>Saved Vocabulary</span>
                     </div>
                     <VocabCardDisplay 
                        data={vocabResult} 
                        onSave={() => toggleSaveVocab(vocabResult)}
                        isSaved={savedItems.some(i => getStoredTitle(i).toLowerCase().trim() === (vocabResult.word || '').toLowerCase().trim())}
                        showSave={true}
                        className="min-h-[60vh] shadow-sm border-slate-200"
                        onSearch={handleTermClick}
                        scrollable={true}
                     />
                </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
};
