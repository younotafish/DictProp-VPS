
import React, { useState, useEffect, useRef } from 'react';
import { analyzeInput, generateIllustration } from '../services/geminiService';
import { SearchResult, StoredItem, VocabCard } from '../types';
import { ArrowRight, Search as SearchIcon, Mic, Loader2, Bookmark, BookmarkMinus, Play, RotateCw, BookOpen } from 'lucide-react';
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
}

// Helper to match title safely
const getStoredTitle = (item: StoredItem) => {
    if (!item || !item.data) return '';
    const data = item.data as any;
    const title = item.type === 'phrase' ? data.query : data.word;
    return String(title || '');
};

export const SearchView: React.FC<SearchProps> = ({ onSave, onUpdateStoredItem, onDelete, savedItems, initialQuery, initialData, onViewDetail }) => {
  const [query, setQuery] = useState(initialQuery || '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [vocabResult, setVocabResult] = useState<VocabCard | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isViewingStored, setIsViewingStored] = useState(false);
  
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
    setResult(null);
    setVocabResult(null);
    setQuery('');
    setError(null);
    setLoading(false);
    setIsViewingStored(false);
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
    <div className="h-full flex flex-col bg-slate-50 relative overflow-hidden">
      
      {/* Top Search Input Area */}
      <div className="w-full p-3 bg-white border-b border-slate-200 z-30 shadow-sm shrink-0">
        <form onSubmit={handleSubmit} className="relative shadow-sm rounded-xl bg-slate-50 focus-within:ring-2 ring-indigo-500 transition-all border border-slate-200">
          <textarea
            ref={textareaRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            placeholder="Ask PopDict..."
            rows={1}
            className="w-full pl-4 pr-12 py-3 text-base rounded-xl bg-transparent text-slate-800 placeholder:text-slate-400 outline-none resize-none overflow-hidden disabled:bg-slate-100 disabled:text-slate-400"
            style={{ minHeight: '48px' }}
          />
          <button 
            type="submit"
            disabled={!query.trim() || loading}
            className="absolute right-1.5 bottom-1.5 w-9 h-9 bg-indigo-600 text-white rounded-lg flex items-center justify-center hover:bg-indigo-700 disabled:opacity-50 disabled:bg-slate-300 transition-colors"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={20} />}
          </button>
        </form>
      </div>
      
      {/* Content Area - Scrollable */}
      <div className="flex-1 overflow-y-auto w-full">
        
        {/* Zero State - Centered in available space */}
        {!result && !vocabResult && !loading && !error && (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center fade-in pb-10">
            <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mb-6 text-indigo-600 animate-bounce-slow">
              <SearchIcon size={40} />
            </div>
            <h1 className="text-3xl font-bold text-slate-800 mb-2">PopDict</h1>
            <p className="text-slate-500 max-w-xs">
              Your AI tutor. Type above to start learning.
            </p>
          </div>
        )}

        {/* Loading State - Centered */}
        {loading && (
          <div className="flex flex-col items-center justify-center h-full fade-in pb-10">
            <Loader2 className="animate-spin text-indigo-600 mb-4" size={40} />
            <p className="text-slate-500 font-medium animate-pulse">Analyzing nuance...</p>
          </div>
        )}

        {/* Error State */}
        {error && (
            <div className="p-8 text-center text-red-500 bg-red-50 m-4 rounded-xl border border-red-100 flex flex-col items-center mt-10">
                <p className="font-bold mb-2">Oops!</p>
                <p className="text-sm">{error}</p>
                <Button variant="ghost" size="sm" className="mt-4 text-red-600 hover:bg-red-100" onClick={handleNewSearch}>
                    Clear
                </Button>
            </div>
        )}

        {/* Result Display */}
        {(result || vocabResult) && !loading && (
          <div className="fade-in pb-6">
            
            {/* Sticky Result Header Context */}
            <div className="sticky top-0 z-10 bg-white/90 backdrop-blur-md border-b border-slate-200 px-4 py-2 flex justify-between items-center shadow-sm">
              <h2 className="font-bold text-slate-800 truncate max-w-[60%] text-sm">{headerTitle}</h2>
              <div className="flex items-center gap-1">
                  {isViewingStored && (
                      <Button variant="ghost" size="sm" onClick={handleRefresh} title="Refresh Analysis">
                          <RotateCw size={18} className="text-slate-400" />
                      </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={toggleSave}>
                    {isSaved ? <BookmarkMinus className="text-indigo-600" /> : <Bookmark />}
                  </Button>
              </div>
            </div>

            {/* Render Search Result (Phrase) */}
            {result && (
                <>
                {/* Hero Card */}
                <div className="p-4 space-y-4">
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                    {/* Generated Image Header */}
                    <div className="h-48 bg-slate-100 relative overflow-hidden flex items-center justify-center">
                    {result.imageUrl ? (
                        <img src={result.imageUrl} alt="Visual context" className="w-full h-full object-cover fade-in" />
                    ) : (
                        <div className="flex flex-col items-center text-slate-400">
                            {imageLoading ? <Loader2 className="animate-spin mb-2"/> : <SearchIcon className="mb-2 opacity-50"/>}
                            <span className="text-xs uppercase font-bold tracking-wider">{result.visualKeyword}</span>
                        </div>
                    )}
                    <div className="absolute bottom-3 right-3">
                        <AudioButton 
                            text={result.query} 
                            className="bg-white/90 backdrop-blur p-3 rounded-full shadow-lg text-indigo-600 active:scale-95 transition-transform"
                            initialIcon={Play}
                            fillIcon={true}
                            iconSize={20}
                        />
                    </div>
                    </div>

                    <div className="p-6">
                        <div className="mb-4">
                            <h2 className="text-2xl font-bold text-slate-900 leading-tight mb-1">{result.translation}</h2>
                            <p className="text-slate-500 font-mono text-sm">{result.pronunciation}</p>
                        </div>
                        
                        <div className="prose prose-indigo prose-sm max-w-none text-slate-600 bg-slate-50 p-4 rounded-xl border border-slate-100">
                            <ReactMarkdown>{result.grammar}</ReactMarkdown>
                        </div>
                    </div>
                </div>
                </div>

                {/* Vocab Carousel */}
                {(result.vocabs || []).length > 0 && (
                    <div className="mb-8">
                        <h3 className="px-6 mb-3 text-sm font-bold text-slate-400 uppercase tracking-wider">Key Vocabulary</h3>
                        <div className="flex overflow-x-auto px-4 gap-4 pb-4 no-scrollbar snap-x items-stretch">
                            {(result.vocabs || []).map((vocab) => (
                                <div key={vocab.id} className="min-w-[85vw] md:min-w-[350px] snap-center h-auto">
                                    <VocabCardDisplay 
                                        data={vocab} 
                                        onSave={() => toggleSaveVocab(vocab)}
                                        isSaved={savedItems.some(i => getStoredTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim())}
                                        onSearch={handleTermClick}
                                        onExpand={() => onViewDetail?.(vocab, 'vocab')}
                                        scrollable={false}
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
                <div className="p-4 h-full pb-10">
                     <div className="flex items-center gap-2 mb-4 px-2 text-slate-400 text-xs uppercase font-bold tracking-wider">
                        <BookOpen size={14} />
                        <span>Saved Vocabulary</span>
                     </div>
                     <VocabCardDisplay 
                        data={vocabResult} 
                        onSave={() => toggleSaveVocab(vocabResult)}
                        isSaved={savedItems.some(i => getStoredTitle(i).toLowerCase().trim() === (vocabResult.word || '').toLowerCase().trim())}
                        showSave={true}
                        className="min-h-[60vh]"
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
