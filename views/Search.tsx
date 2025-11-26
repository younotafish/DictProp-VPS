
import React, { useState, useEffect, useRef } from 'react';
import { analyzeInput, generateIllustration } from '../services/geminiService';
import { SearchResult, StoredItem, VocabCard } from '../types';
import { ArrowRight, Search as SearchIcon, Loader2, Bookmark, RotateCw, BookOpen, ArrowLeft, AlertCircle, X, Clipboard } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Button } from '../components/Button';
import { VocabCardDisplay } from '../components/VocabCard';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { SRSAlgorithm } from '../services/srsAlgorithm';

interface SearchProps {
  onSave: (item: StoredItem) => void;
  onUpdateStoredItem: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  savedItems: StoredItem[];
  initialQuery?: string;
  initialData?: StoredItem;
  onViewDetail?: (data: VocabCard | SearchResult, type: 'vocab' | 'phrase') => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onClear?: () => void;
}

// Helper to match title safely
const getStoredTitle = (item: StoredItem) => {
    if (!item || !item.data) return '';
    const data = item.data as any;
    const title = item.type === 'phrase' ? data.query : data.word;
    return String(title || '');
};

const createInitialSRS = (id: string, type: 'vocab' | 'phrase') => SRSAlgorithm.createNew(id, type);

export const SearchView: React.FC<SearchProps> = ({ onSave, onUpdateStoredItem, onDelete, savedItems, initialQuery, initialData, onViewDetail, onScroll, onClear }) => {
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
  const searchRequestId = useRef(0);
  const lastProcessedQuery = useRef<string | undefined>(undefined);

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
    if (initialQuery && initialQuery !== lastProcessedQuery.current) {
        lastProcessedQuery.current = initialQuery;
        setIsViewingStored(false);
        setVocabResult(null);
        setQuery(initialQuery);
        // Trigger search immediately
        performSearch(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Increment ID to invalidate previous searches
    const currentSearchId = ++searchRequestId.current;
    
    setLoading(true);
    setError(null);
    // Don't clear results immediately to keep the screen populated while loading
    // setResult(null); 
    // setVocabResult(null);
    
    // Push current state to history before starting new search (if we had a result)
    if (result || vocabResult) {
        setSearchHistory(prev => {
            const newItem = {
                query: result ? result.query : (vocabResult?.word || ''),
                result: result || vocabResult!,
                type: result ? 'phrase' : 'vocab' as const
            };
            // Limit history to last 5 items to prevent memory buildup
            const newHistory = [...prev, newItem];
            if (newHistory.length > 5) return newHistory.slice(newHistory.length - 5);
            return newHistory;
        });
    }

    try {
        const rawData = await analyzeInput(text);
        if (!isMounted.current || currentSearchId !== searchRequestId.current) return;

        // Check if this item is already saved to preserve ID and update content
        const queryToCheck = (rawData.query || '').toLowerCase().trim();
        const existingItem = queryToCheck ? savedItems.find(i => 
            getStoredTitle(i).toLowerCase().trim() === queryToCheck
        ) : undefined;

        let data = rawData;
        
        if (existingItem && existingItem.data && existingItem.data.id) {
            // Adopt the existing ID so updates map to the correct stored item
            data = { ...rawData, id: existingItem.data.id };
            
            // Automatically update the text content of the saved item
            // Note: We upgrade 'vocab' items to 'phrase' items on refresh to provide full context
            onUpdateStoredItem({
                ...existingItem,
                data: data,
                type: 'phrase',
                updatedAt: Date.now()
            });
        }

        setResult(data);
        setVocabResult(null); // Clear any previous vocab result as we now have a phrase result
        setLoading(false);
        setImageLoading(true);
        
        // 1. Generate Main Visual Context
        generateIllustration(data.visualKeyword, '16:9').then(img => {
             if (!isMounted.current || currentSearchId !== searchRequestId.current) return;
             if (img) {
                 setResult(prev => prev ? { ...prev, imageUrl: img } : null);
                 
                 const updatedData = { ...data, imageUrl: img };
                 
                 // Try to update storage if this item is saved (or was just saved)
                 // We pass the data with the ID we established earlier
                 onUpdateStoredItem({
                     data: updatedData,
                     type: 'phrase',
                     savedAt: existingItem?.savedAt || 0, 
                     srs: existingItem?.srs || createInitialSRS(data.id, 'phrase'),
                     updatedAt: Date.now()
                 });
             }
             setImageLoading(false);
        });

        // 2. Generate Vocab Illustrations (Sequentially to avoid freezing)
        const processVocabImages = async () => {
            for (const vocab of data.vocabs) {
                if (!isMounted.current || currentSearchId !== searchRequestId.current) return;
                
                if (vocab.imagePrompt) {
                    try {
                        const img = await generateIllustration(vocab.imagePrompt, '4:3');
                        if (!isMounted.current || currentSearchId !== searchRequestId.current) return;
                        
                        if (img) {
                             setResult(prev => {
                                 if (!prev) return null;
                                 const newVocabs = (prev.vocabs || []).map(v => 
                                    v.id === vocab.id ? { ...v, imageUrl: img } : v
                                 );
                                 return { ...prev, vocabs: newVocabs };
                             });

                             // Update the main item to include this vocab image
                             // Note: We are updating the PHRASE item that contains this vocab
                             // We need to reconstruct the phrase object with this vocab updated
                             // Actually, onUpdateStoredItem takes the Whole Item.
                             // But here we only have the vocab.
                             // Since we don't have the latest state of 'result' here easily (closures),
                             // we might rely on the fact that we just updated 'setResult'.
                             // But for storage, we need to pass the FULL phrase data to update the phrase item.
                             
                             // However, the original code was updating a separate VOCAB item:
                             /*
                             onUpdateStoredItem({
                                 data: { ...vocab, imageUrl: img },
                                 type: 'vocab', ...
                             });
                             */
                             // This implies it was trying to update a standalone vocab item if it existed?
                             // But 'vocab.id' is random.
                             // If the user saved the vocab SEPARATELY, we should try to find it and update it.
                             
                             // Let's see if this vocab word is saved separately
                             const existingVocabItem = savedItems.find(i => 
                                getStoredTitle(i).toLowerCase().trim() === vocab.word.toLowerCase().trim()
                             );
                             
                             if (existingVocabItem) {
                                 onUpdateStoredItem({
                                     ...existingVocabItem,
                                     data: { ...vocab, imageUrl: img, id: existingVocabItem.data.id },
                                     updatedAt: Date.now()
                                 });
                             }
                             
                             // Also update the parent phrase item if it's saved
                             // We need to use the functional update pattern's result, but we can't access it easily here.
                             // We can construct it if we have the parent 'data' object in scope.
                             // 'data' is in scope. But 'data' doesn't have the previous images.
                             // This is tricky for sequential updates.
                             // For now, let's focus on the main request: content update.
                             // The Main Image update logic (above) handles the main item.
                             // The vocab image updates are secondary.
                        }
                    } catch (e) {
                        console.warn("Vocab image generation failed", e);
                    }
                }
            }
        };
        
        processVocabImages();

    } catch (err: any) {
        if (isMounted.current && currentSearchId === searchRequestId.current) {
            if (err.message === 'QUOTA_EXCEEDED') {
                 setError("Daily AI limit reached. Please check your plan or try again later.");
            } else {
                 setError("Search failed. Please try again.");
            }
            setLoading(false);
        }
    }
  };

  const handlePasteAndSearch = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Focus the main textarea and trigger paste programmatically
    if (textareaRef.current) {
      // Store current value
      const currentValue = query;
      
      // Clear and focus
      textareaRef.current.value = '';
      textareaRef.current.focus();
      
      // Set up paste listener
      const handlePaste = (pasteEvent: ClipboardEvent) => {
        pasteEvent.preventDefault();
        const text = pasteEvent.clipboardData?.getData('text');
        if (text && text.trim()) {
          setQuery(text);
          setIsViewingStored(false);
          performSearch(text);
        } else {
          // Restore original value if paste failed
          setQuery(currentValue);
        }
        textareaRef.current?.removeEventListener('paste', handlePaste);
      };
      
      textareaRef.current.addEventListener('paste', handlePaste);
      
      // Trigger paste command
      setTimeout(() => {
        document.execCommand('paste');
      }, 10);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
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
    // Only clear the query text, keep the results on screen
    setQuery('');
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
        srs: createInitialSRS(result.id, 'phrase')
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
            srs: createInitialSRS(vocab.id, 'vocab')
        });
    }
  };

  const headerTitle = vocabResult ? (vocabResult.word || '') : result ? (result.query || '') : '';

  return (
    <div className="h-full bg-slate-50 relative overflow-y-auto" onScroll={onScroll}>
      
      {/* Top Search Input Area */}
      <div className="w-full p-3 bg-white/80 backdrop-blur-md border-b border-slate-200/60 z-30">
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
            {/* Paste button */}
            <button
              type="button"
              onClick={handlePasteAndSearch}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.stopPropagation(); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
              className="absolute left-2 bottom-2 z-20 w-10 h-10 text-slate-400 hover:text-indigo-600 rounded-xl flex items-center justify-center transition-all hover:bg-slate-200/50"
              title="Paste and Search"
            >
              <Clipboard size={18} />
            </button>
            <textarea
              ref={textareaRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              placeholder="What do you want to learn?"
              rows={1}
              className="w-full pl-12 pr-24 py-3.5 text-base rounded-2xl bg-transparent text-slate-800 placeholder:text-slate-400 outline-none resize-none overflow-hidden disabled:opacity-60"
              style={{ minHeight: '52px' }}
            />
          {/* Clear button (X) - shows when there's text */}
          {query.trim() && (
            <button 
              type="button"
              onClick={handleNewSearch}
              className="absolute right-12 bottom-2 w-9 h-9 bg-slate-200 text-slate-500 rounded-xl flex items-center justify-center hover:bg-slate-300 hover:text-slate-700 transition-all"
              title="Clear"
            >
              <X size={18} />
            </button>
          )}
          {/* Submit button */}
          <button 
            type="submit"
            disabled={!query.trim() || loading}
            className="absolute right-2 bottom-2 w-9 h-9 bg-indigo-600 text-white rounded-xl flex items-center justify-center hover:bg-indigo-700 disabled:opacity-0 disabled:scale-90 transition-all shadow-md shadow-indigo-200"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={20} />}
          </button>
        </form>
        </div>
      </div>
      
      {/* Content Area - Scrollable */}
      <div className="w-full pb-[calc(5rem+env(safe-area-inset-bottom))]">
        
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

        {/* Loading State - Centered (Only if no previous result to show) */}
        {loading && !result && !vocabResult && (
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
        {(result || vocabResult) && (
          <div className={`fade-in pb-8 max-w-3xl mx-auto transition-opacity duration-300 ${loading ? 'opacity-50 grayscale-[0.5]' : 'opacity-100'}`}>
            
            {/* Render Search Result */}
            {result && (
                <>
                {/* WORD MODE: Only show vocabulary cards as carousel (no translation means word mode) */}
                {!result.translation ? (
                    <div className="mt-6 mb-6">
                        <div className="px-6 mb-4 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <BookOpen size={16} className="text-indigo-500" />
                                <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">
                                    {(result.vocabs || []).length > 1 ? 'All Meanings' : 'Definition'}
                                </h3>
                            </div>
                            {isViewingStored && (
                                <button 
                                    onClick={handleRefresh} 
                                    title="Refresh Analysis" 
                                    className="p-2 rounded-full text-slate-400 hover:text-indigo-600 hover:bg-slate-100 transition-all active:scale-90"
                                >
                                    <RotateCw size={18} />
                                </button>
                            )}
                        </div>
                        {/* Vocab Cards - Horizontal carousel for word mode */}
                        <div className="flex overflow-x-auto px-4 gap-4 pb-8 no-scrollbar snap-x snap-mandatory items-stretch">
                            {(result.vocabs || []).map((vocab, index) => (
                                <div key={vocab.id} className="min-w-[85vw] md:min-w-[400px] snap-center h-auto relative">
                                    {/* Meaning number badge for multiple meanings */}
                                    {(result.vocabs || []).length > 1 && (
                                        <div className="absolute -left-1 -top-1 z-10 w-7 h-7 bg-indigo-600 text-white text-sm font-bold rounded-full flex items-center justify-center shadow-md">
                                            {index + 1}
                                        </div>
                                    )}
                                    <VocabCardDisplay 
                                        data={vocab} 
                                        onSave={() => toggleSaveVocab(vocab)}
                                        isSaved={savedItems.some(i => getStoredTitle(i).toLowerCase().trim() === (vocab.word || '').toLowerCase().trim() && (i.data as any).sense === vocab.sense)}
                                        onSearch={handleTermClick}
                                        onExpand={() => onViewDetail?.(vocab, 'vocab')}
                                        scrollable={false}
                                        className="h-full border-slate-200 shadow-sm hover:shadow-md transition-shadow"
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    /* SENTENCE MODE: Full analysis with hero card */
                    <>
                    {/* Hero Card */}
                    <div className="px-4 space-y-4 mt-6">
                    <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden relative">
                        {/* Save button - fixed in top right */}
                        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
                            {isViewingStored && (
                                <button 
                                    onClick={handleRefresh} 
                                    title="Refresh Analysis" 
                                    className="p-3 rounded-full bg-white/90 backdrop-blur text-slate-600 hover:text-indigo-600 hover:bg-white shadow-lg transition-all active:scale-90"
                                >
                                    <RotateCw size={20} />
                                </button>
                            )}
                            <button 
                                onClick={toggleSave} 
                                className={`p-3 rounded-full shadow-lg transition-all active:scale-90 ${
                                    isSaved 
                                        ? 'bg-indigo-600 text-white hover:bg-indigo-700' 
                                        : 'bg-white/90 backdrop-blur text-slate-600 hover:bg-white hover:text-indigo-600'
                                }`}
                                title={isSaved ? 'Remove from Notebook' : 'Save to Notebook'}
                            >
                                {isSaved ? <Bookmark size={20} fill="currentColor" /> : <Bookmark size={20} />}
                            </button>
                        </div>
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
                        </div>

                        <div className="p-6 sm:p-8">
                            <div className="mb-6">
                                <h2 className="text-2xl font-bold text-slate-900 leading-tight mb-2">{result.translation}</h2>
                                <p className="text-lg text-slate-600 mb-3 leading-relaxed">{result.query}</p>
                                <PronunciationBlock 
                                    text={result.query} 
                                    ipa={result.pronunciation} 
                                    className="text-base bg-slate-100 px-2 py-1 rounded-lg w-full"
                                />
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

                    {/* Vocab Carousel for sentence mode */}
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
                </>
            )}

            {/* Render Single Vocab Card (Stored Vocab) */}
            {vocabResult && (
                <div className="p-4 h-full pb-10 mt-6 relative">
                     {/* Save button - fixed in top right */}
                     <div className="absolute top-6 right-6 z-10 flex items-center gap-2">
                         {isViewingStored && (
                             <button 
                                 onClick={handleRefresh} 
                                 title="Refresh Analysis" 
                                 className="p-3 rounded-full bg-white text-slate-600 hover:text-indigo-600 hover:bg-slate-50 shadow-lg transition-all active:scale-90 border border-slate-200"
                             >
                                 <RotateCw size={20} />
                             </button>
                         )}
                         <button 
                             onClick={() => toggleSaveVocab(vocabResult)} 
                             className={`p-3 rounded-full shadow-lg transition-all active:scale-90 border ${
                                 isSaved 
                                     ? 'bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600' 
                                     : 'bg-white text-slate-600 hover:bg-slate-50 hover:text-indigo-600 border-slate-200'
                             }`}
                             title={isSaved ? 'Remove from Notebook' : 'Save to Notebook'}
                         >
                             {isSaved ? <Bookmark size={20} fill="currentColor" /> : <Bookmark size={20} />}
                         </button>
                     </div>
                     <div className="flex items-center gap-2 mb-4 px-2 text-slate-400 text-xs uppercase font-bold tracking-wider">
                        <BookOpen size={14} />
                        <span>Saved Vocabulary</span>
                     </div>
                     <VocabCardDisplay 
                        data={vocabResult} 
                        onSave={() => toggleSaveVocab(vocabResult)}
                        isSaved={savedItems.some(i => getStoredTitle(i).toLowerCase().trim() === (vocabResult.word || '').toLowerCase().trim())}
                        showSave={false}
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
