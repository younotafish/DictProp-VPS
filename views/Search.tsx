import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { analyzeInput, generateIllustration } from '../services/geminiService';
import { SearchResult, StoredItem, VocabCard, getItemTitle } from '../types';
import { ArrowRight, Search as SearchIcon, Loader2, Bookmark, RotateCw, BookOpen, ArrowLeft, AlertCircle, X, Clipboard, ChevronLeft, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Button } from '../components/Button';
import { VocabCardDisplay } from '../components/VocabCard';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { OfflineImage } from '../components/OfflineImage';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { useKeyboardNavigation, useWheelNavigation } from '../hooks';

interface SearchProps {
  onSave: (item: StoredItem) => void;
  onUpdateStoredItem: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  savedItems: StoredItem[];
  initialQuery?: string;
  initialData?: StoredItem;
  forceRefresh?: boolean; // When true, bypass local cache and call AI
  onForceRefreshComplete?: () => void; // Called after force refresh search starts
  onViewDetail?: (data: VocabCard | SearchResult, type: 'vocab' | 'phrase') => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onClear?: () => void;
}

export const SearchView: React.FC<SearchProps> = ({ onSave, onUpdateStoredItem, onDelete, savedItems, initialQuery, initialData, forceRefresh, onForceRefreshComplete, onViewDetail, onScroll, onClear }) => {
  const [query, setQuery] = useState(initialQuery || '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [vocabResult, setVocabResult] = useState<VocabCard | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isViewingStored, setIsViewingStored] = useState(false);
  const [searchHistory, setSearchHistory] = useState<Array<{query: string, result: SearchResult | VocabCard, type: 'phrase' | 'vocab'}>>([]);
  
  // Carousel state for vocab cards
  const [vocabIndex, setVocabIndex] = useState(0);
  const touchStart = useRef<{x: number, y: number} | null>(null);
  const SWIPE_THRESHOLD = 50;
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  
  // Calculate total vocabs for keyboard navigation
  const totalVocabs = useMemo(() => result?.vocabs?.length || 0, [result]);
  
  // Keyboard navigation for carousel
  useKeyboardNavigation({
    onArrowLeft: () => {
      if (totalVocabs > 1 && vocabIndex > 0) {
        setVocabIndex(prev => prev - 1);
      }
    },
    onArrowRight: () => {
      if (totalVocabs > 1 && vocabIndex < totalVocabs - 1) {
        setVocabIndex(prev => prev + 1);
      }
    },
    onEnter: () => {
      const currentVocab = result?.vocabs?.[vocabIndex];
      if (currentVocab && onViewDetail) {
        onViewDetail(currentVocab, 'vocab');
      }
    },
    enabled: !loading && (result !== null || vocabResult !== null),
  });
  
  // Trackpad wheel navigation for carousel
  useWheelNavigation({
    onScrollLeft: () => {
      if (totalVocabs > 1 && vocabIndex > 0) {
        setVocabIndex(prev => prev - 1);
      }
    },
    onScrollRight: () => {
      if (totalVocabs > 1 && vocabIndex < totalVocabs - 1) {
        setVocabIndex(prev => prev + 1);
      }
    },
    containerRef: carouselRef,
    threshold: 80,
    enabled: totalVocabs > 1,
  });
  const isMounted = useRef(true);
  const searchRequestId = useRef(0);
  const lastProcessedQuery = useRef<string | undefined>(undefined);
  const lastResultQuery = useRef<string | undefined>(undefined);
  
  // Reset vocab index only when a NEW search result arrives (different query)
  // Don't reset when just the images are updated
  useEffect(() => {
    const currentQuery = result?.query || vocabResult?.word;
    if (currentQuery && currentQuery !== lastResultQuery.current) {
      setVocabIndex(0);
      lastResultQuery.current = currentQuery;
    }
  }, [result, vocabResult]);

  useEffect(() => {
      isMounted.current = true;
      return () => { isMounted.current = false; };
  }, []);

  // Memoized title lookup - avoids recalculating on every render
  const { currentTitle, savedItemMatch, isSaved } = useMemo(() => {
    const title = vocabResult 
      ? (vocabResult.word || '')
      : result 
          ? (result.query || '') 
          : '';
    
    const match = title 
      ? savedItems.find(item => getItemTitle(item).toLowerCase().trim() === title.toLowerCase().trim())
      : undefined;
    
    return {
      currentTitle: title,
      savedItemMatch: match,
      isSaved: !!match
    };
  }, [vocabResult, result, savedItems]);
  
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

  // Handle Initial Query (Recursive search) with optional force refresh
  useEffect(() => {
    if (initialQuery && (initialQuery !== lastProcessedQuery.current || forceRefresh)) {
        lastProcessedQuery.current = initialQuery;
        setIsViewingStored(false);
        setVocabResult(null);
        setQuery(initialQuery);
        // Trigger search immediately, bypassing local cache if forceRefresh is true
        performSearch(initialQuery, forceRefresh);
        // Notify parent that force refresh has been handled
        if (forceRefresh && onForceRefreshComplete) {
            onForceRefreshComplete();
        }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, forceRefresh]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [query]);

  const handleBack = useCallback(() => {
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
  }, [searchHistory]);

  const performSearch = async (text: string, skipLocalCache: boolean = false) => {
    // Increment ID to invalidate previous searches
    const currentSearchId = ++searchRequestId.current;
    
    // Check if the query matches existing saved items (case-insensitive)
    // Skip this check if skipLocalCache is true (force refresh from AI)
    const queryLower = text.toLowerCase().trim();
    const existingItems = skipLocalCache ? [] : savedItems.filter(item => 
        getItemTitle(item).toLowerCase().trim() === queryLower
    );
    
    // If found in local storage, display directly without API call
    if (existingItems.length > 0) {
        // Push current state to history before showing stored item
        if (result || vocabResult) {
            setSearchHistory(prev => {
                const itemType: 'phrase' | 'vocab' = result ? 'phrase' : 'vocab';
                const newItem = {
                    query: result ? result.query : (vocabResult?.word || ''),
                    result: result || vocabResult!,
                    type: itemType
                };
                const newHistory = [...prev, newItem];
                if (newHistory.length > 5) return newHistory.slice(newHistory.length - 5);
                return newHistory;
            });
        }
        
        setIsViewingStored(true);
        setLoading(false);
        setError(null);
        
        // Check if any saved item is a phrase
        const phraseItem = existingItems.find(i => i.type === 'phrase');
        if (phraseItem) {
            setResult(phraseItem.data as SearchResult);
            setVocabResult(null);
        } else {
            // All are vocab items - construct a result with all meanings
            const vocabItems = existingItems.map(i => i.data as VocabCard);
            if (vocabItems.length === 1) {
                // Single meaning - show as single vocab
                setVocabResult(vocabItems[0]);
                setResult(null);
            } else {
                // Multiple meanings - show as SearchResult with vocabs array
                setResult({
                    id: vocabItems[0].id,
                    query: text,
                    translation: '', // Empty = word mode (shows vocab carousel)
                    grammar: '',
                    visualKeyword: '',
                    pronunciation: vocabItems[0].ipa || '',
                    vocabs: vocabItems,
                    timestamp: Date.now()
                });
                setVocabResult(null);
            }
        }
        return;
    }
    
    // Check if offline before making API call
    if (!navigator.onLine) {
        setError("You're offline. Search only works for saved words when offline.");
        setLoading(false);
        return;
    }
    
    setLoading(true);
    setError(null);
    // Don't clear results immediately to keep the screen populated while loading
    // setResult(null); 
    // setVocabResult(null);
    
    // Push current state to history before starting new search (if we had a result)
    if (result || vocabResult) {
        setSearchHistory(prev => {
            const itemType: 'phrase' | 'vocab' = result ? 'phrase' : 'vocab';
            const newItem = {
                query: result ? result.query : (vocabResult?.word || ''),
                result: result || vocabResult!,
                type: itemType
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
        
        // Find ALL existing saved items with same title (could be multiple meanings)
        const existingItems = queryToCheck ? savedItems.filter(i => 
            getItemTitle(i).toLowerCase().trim() === queryToCheck
        ) : [];
        
        // Primary existing item (first match, used for main ID)
        const existingItem = existingItems[0];

        let data = rawData;
        
        // Map vocab IDs - preserve existing IDs for vocabs that match saved items
        // Uses fuzzy sense matching: same part-of-speech = same meaning
        // This handles AI returning slightly different descriptions while keeping meanings separate
        const usedIds = new Set<string>(); // Track IDs we've already assigned to prevent duplicates
        
        // Extract part of speech from sense (e.g., "noun: agricultural produce" → "noun")
        const getPartOfSpeech = (sense: string): string => {
            const match = sense.toLowerCase().match(/^(noun|verb|adjective|adverb|adj|adv|prep|preposition|conjunction|conj|interjection|pronoun|article|determiner)/);
            return match ? match[1] : '';
        };
        
        const mappedVocabs = (rawData.vocabs || []).map((vocab) => {
            const vocabTitle = (vocab.word || '').toLowerCase().trim();
            const vocabPOS = getPartOfSpeech(vocab.sense || '');
            
            // Find saved vocab with same title and same part of speech
            // This allows "noun: agricultural produce" to match "noun: crops grown for food"
            // But prevents "noun: produce" from matching "verb: to harvest"
            const existingSavedVocab = savedItems.find(i => {
                if (i.type !== 'vocab') return false;
                const savedTitle = getItemTitle(i).toLowerCase().trim();
                const savedSense = (i.data as VocabCard).sense || '';
                const savedPOS = getPartOfSpeech(savedSense);
                const savedId = i.data.id;
                
                // Must match title, part-of-speech must match, and ID must not be already used
                // Empty POS matches empty POS (for senses without clear part-of-speech)
                return savedTitle === vocabTitle && 
                       savedPOS === vocabPOS &&
                       !usedIds.has(savedId);
            });
            
            if (existingSavedVocab && existingSavedVocab.data.id) {
                // Adopt existing ID and preserve existing image if new one isn't available
                usedIds.add(existingSavedVocab.data.id);
                return { 
                    ...vocab, 
                    id: existingSavedVocab.data.id,
                    imageUrl: vocab.imageUrl || (existingSavedVocab.data as VocabCard).imageUrl
                };
            }
            
            // No match - keep the new unique ID from AI
            return vocab;
        });
        
        data = { ...rawData, vocabs: mappedVocabs };
        
        if (existingItem && existingItem.data && existingItem.data.id) {
            // Adopt the existing ID so updates map to the correct stored item
            data = { ...data, id: existingItem.data.id };
            
            // Automatically update ALL existing items with same title
            // This handles cases where user saved multiple meanings
            existingItems.forEach(existing => {
                if (existing.type === 'vocab') {
                    // For vocab items, find the matching vocab from the new data by ID
                    const matchingVocab = mappedVocabs.find(v => v.id === existing.data.id);
                    if (matchingVocab) {
                        onUpdateStoredItem({
                            ...existing,
                            data: matchingVocab,
                            type: 'vocab',
                            updatedAt: Date.now()
                        });
                    }
                } else {
                    // For phrase items, update with the full SearchResult
                    onUpdateStoredItem({
                        ...existing,
                        data: { ...data, id: existing.data.id },
                        type: 'phrase',
                        updatedAt: Date.now()
                    });
                }
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
                     srs: existingItem?.srs || SRSAlgorithm.createNew(data.id, 'phrase'),
                     updatedAt: Date.now()
                 });
             }
             setImageLoading(false);
        });

        // 2. Generate Vocab Illustrations (Sequentially to avoid freezing)
        const processVocabImages = async () => {
            for (const vocab of data.vocabs) {
                if (!isMounted.current || currentSearchId !== searchRequestId.current) return;
                
                // Skip if vocab already has an image (preserved from existing saved item)
                if (vocab.imageUrl) continue;
                
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

                             // Always try to update saved item - don't rely on stale savedItems prop
                             // The onUpdateStoredItem handler will check current state and update if exists
                             // This ensures images are saved even if user saved item after search started
                             onUpdateStoredItem({
                                 data: { ...vocab, imageUrl: img },
                                 type: 'vocab',
                                 savedAt: 0, // Will be ignored if item exists
                                 updatedAt: Date.now()
                             });
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
            const msg = err.message || '';
            
            if (msg === 'QUOTA_EXCEEDED') {
                setError("Daily AI limit reached. Please check your plan or try again later.");
            } else if (msg.includes('Firebase functions not initialized')) {
                setError("Service not configured. Please check your setup.");
            } else if (!navigator.onLine) {
                // Went offline during the request
                setError("You're offline. Search only works for saved words when offline.");
            } else {
                setError("Search failed. Please check your connection and try again.");
            }
            setLoading(false);
        }
    }
  };

  const handlePasteAndSearch = async (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    try {
      // Use modern Clipboard API
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setQuery(text.trim());
        setIsViewingStored(false);
        performSearch(text.trim());
        textareaRef.current?.focus();
      }
    } catch (err) {
      // Clipboard API might fail due to permissions - fallback: just focus the input
      console.warn("Clipboard read failed, please paste manually", err);
      textareaRef.current?.focus();
    }
  };

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setIsViewingStored(false);
    performSearch(query);
  }, [query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const handleRefresh = useCallback(() => {
      setIsViewingStored(false);
      performSearch(query);
  }, [query]);

  const handleNewSearch = useCallback(() => {
    // Only clear the query text, keep the results on screen
    setQuery('');
  }, []);

  const handleTermClick = useCallback((term: string) => {
      setQuery(term);
      setIsViewingStored(false);
      performSearch(term);
  }, []);

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
        srs: SRSAlgorithm.createNew(result.id, 'phrase')
      });
    }
  };

  const toggleSaveVocab = (vocab: VocabCard) => {
    // Ensure vocab word exists to prevent crash
    const word = vocab.word || '';
    if (!word) return;

    // First check by ID (most reliable - handles refreshed items with adopted IDs)
    let savedVocabMatch = vocab.id ? savedItems.find(item => item.data.id === vocab.id) : undefined;
    
    // If not found by ID, check by word AND sense (for items that weren't refreshed)
    if (!savedVocabMatch) {
        savedVocabMatch = savedItems.find(item => {
            const titleMatch = getItemTitle(item).toLowerCase().trim() === word.toLowerCase().trim();
            if (!titleMatch) return false;
            
            // For vocab items, also check if the sense matches
            if (item.type === 'vocab') {
                const itemSense = (item.data as any).sense || '';
                const vocabSense = vocab.sense || '';
                return itemSense === vocabSense;
            }
            return true;
        });
    }

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
            srs: SRSAlgorithm.createNew(vocab.id, 'vocab')
        });
    }
  };

  return (
    <div className="h-full bg-slate-50 relative overflow-y-scroll overscroll-y-contain" onScroll={onScroll} style={{ touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' }}>
      
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
                        {/* Vocab Cards - Touch-based carousel for word mode */}
                        {(() => {
                            const vocabs = result.vocabs || [];
                            const totalVocabs = vocabs.length;
                            const currentVocab = vocabs[vocabIndex] || vocabs[0];
                            
                            if (!currentVocab) return null;
                            
                            const handleCarouselTouchStart = (e: React.TouchEvent) => {
                                touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                            };
                            
                            const handleCarouselTouchEnd = (e: React.TouchEvent) => {
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
                                
                                // Only handle horizontal swipes
                                if (absX > absY * 1.2 && absX > SWIPE_THRESHOLD) {
                                    if (diffX < 0 && vocabIndex < totalVocabs - 1) {
                                        // Swipe left - next card
                                        setVocabIndex(prev => prev + 1);
                                    } else if (diffX > 0 && vocabIndex > 0) {
                                        // Swipe right - previous card
                                        setVocabIndex(prev => prev - 1);
                                    }
                                }
                                touchStart.current = null;
                            };
                            
                                return (
                                <div 
                                    ref={carouselRef}
                                    className="px-4 pb-4"
                                    onTouchStart={handleCarouselTouchStart}
                                    onTouchEnd={handleCarouselTouchEnd}
                                    style={{ touchAction: 'pan-y' }}
                                >
                                    <div className="relative">
                                        {/* Meaning number badge */}
                                        {totalVocabs > 1 && (
                                            <div className="absolute -left-1 -top-1 z-10 w-7 h-7 bg-indigo-600 text-white text-sm font-bold rounded-full flex items-center justify-center shadow-md">
                                                {vocabIndex + 1}
                                            </div>
                                        )}
                                        {/* Previous card button - keyboard/trackpad accessible */}
                                        {totalVocabs > 1 && vocabIndex > 0 && (
                                            <button
                                                onClick={() => setVocabIndex(prev => prev - 1)}
                                                className="absolute -left-3 top-1/2 -translate-y-1/2 z-10 w-8 h-8 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
                                                aria-label="Previous meaning"
                                            >
                                                <ChevronLeft size={18} />
                                            </button>
                                        )}
                                        {/* Next card button - keyboard/trackpad accessible */}
                                        {totalVocabs > 1 && vocabIndex < totalVocabs - 1 && (
                                            <button
                                                onClick={() => setVocabIndex(prev => prev + 1)}
                                                className="absolute -right-3 top-1/2 -translate-y-1/2 z-10 w-8 h-8 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
                                                aria-label="Next meaning"
                                            >
                                                <ChevronRight size={18} />
                                            </button>
                                        )}
                                        <VocabCardDisplay 
                                            data={currentVocab} 
                                            onSave={() => toggleSaveVocab(currentVocab)}
                                            isSaved={savedItems.some(i => i.data.id === currentVocab.id || (getItemTitle(i).toLowerCase().trim() === (currentVocab.word || '').toLowerCase().trim() && (i.data as any).sense === currentVocab.sense))}
                                            onSearch={handleTermClick}
                                            onExpand={() => onViewDetail?.(currentVocab, 'vocab')}
                                            scrollable={false}
                                            className="border-slate-200 shadow-sm"
                                        />
                                    </div>
                                    
                                    {/* Dot indicators */}
                                    {totalVocabs > 1 && (
                                        <div className="flex justify-center gap-1.5 mt-3">
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
                                </div>
                            );
                        })()}
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
                            <OfflineImage src={result.imageUrl} alt="Visual context" className="w-full h-full object-cover fade-in transition-transform duration-700 group-hover:scale-105" />
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

                    {/* Vocab Carousel for sentence mode - uses same carousel component */}
                    {(result.vocabs || []).length > 0 && (
                        <div className="mt-8 mb-6">
                            <div className="px-6 mb-4 flex items-center gap-2">
                                <BookOpen size={16} className="text-indigo-500" />
                                <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Key Vocabulary</h3>
                            </div>
                            {(() => {
                                const vocabs = result.vocabs || [];
                                const totalVocabs = vocabs.length;
                                const currentVocab = vocabs[vocabIndex] || vocabs[0];
                                
                                if (!currentVocab) return null;
                                
                                const handleCarouselTouchStart = (e: React.TouchEvent) => {
                                    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                                };
                                
                                const handleCarouselTouchEnd = (e: React.TouchEvent) => {
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
                                    
                                    if (absX > absY * 1.2 && absX > SWIPE_THRESHOLD) {
                                        if (diffX < 0 && vocabIndex < totalVocabs - 1) {
                                            setVocabIndex(prev => prev + 1);
                                        } else if (diffX > 0 && vocabIndex > 0) {
                                            setVocabIndex(prev => prev - 1);
                                        }
                                    }
                                    touchStart.current = null;
                                };
                                
                                return (
                                    <div 
                                        className="px-4 pb-4"
                                        onTouchStart={handleCarouselTouchStart}
                                        onTouchEnd={handleCarouselTouchEnd}
                                        style={{ touchAction: 'pan-y' }}
                                    >
                                        <div className="relative">
                                            <VocabCardDisplay 
                                                data={currentVocab} 
                                                onSave={() => toggleSaveVocab(currentVocab)}
                                                isSaved={savedItems.some(i => i.data.id === currentVocab.id || (getItemTitle(i).toLowerCase().trim() === (currentVocab.word || '').toLowerCase().trim() && (i.data as any).sense === currentVocab.sense))}
                                                onSearch={handleTermClick}
                                                onExpand={() => onViewDetail?.(currentVocab, 'vocab')}
                                                scrollable={false}
                                                className="border-slate-200 shadow-sm"
                                            />
                                        </div>
                                        
                                        {totalVocabs > 1 && (
                                            <div className="flex justify-center gap-1.5 mt-3">
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
                                    </div>
                                );
                            })()}
                        </div>
                    )}
                    </>
                )}
                </>
            )}

            {/* Render Single Vocab Card (Stored Vocab) */}
            {vocabResult && (
                <div className="p-4 pb-10 mt-6 relative">
                     {/* Save button - fixed in top right */}
                     <div className="absolute top-6 right-6 z-10 flex items-center gap-2">
                         {isViewingStored && (
                             <button 
                                 onClick={handleRefresh} 
                                 title="Get all meanings" 
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
                     <div className="flex items-center justify-between mb-4 px-2">
                        <div className="flex items-center gap-2 text-slate-400 text-xs uppercase font-bold tracking-wider">
                            <BookOpen size={14} />
                            <span>Saved Vocabulary</span>
                        </div>
                        {isViewingStored && (
                            <button 
                                onClick={handleRefresh}
                                className="text-xs text-indigo-500 hover:text-indigo-700 font-medium flex items-center gap-1"
                            >
                                <RotateCw size={12} />
                                Get all meanings
                            </button>
                        )}
                     </div>
                     <VocabCardDisplay 
                        data={vocabResult} 
                        onSave={() => toggleSaveVocab(vocabResult)}
                        isSaved={savedItems.some(i => i.data.id === vocabResult.id || (getItemTitle(i).toLowerCase().trim() === (vocabResult.word || '').toLowerCase().trim() && (i.data as any).sense === vocabResult.sense))}
                        showSave={false}
                        className="shadow-sm border-slate-200"
                        onSearch={handleTermClick}
                        scrollable={false}
                     />
                </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
};
