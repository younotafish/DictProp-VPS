import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, Loader2, Send, ChevronLeft, ChevronRight } from 'lucide-react';
import { SearchResult, VocabCard, StoredItem } from '../types';
import { analyzeInput, generateIllustration } from '../services/api';
import { VocabCardDisplay } from './VocabCard';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { speak } from '../services/speech';
import { log, warn } from '../services/logger';

type Mode = 'idle' | 'input' | 'searching' | 'ready' | 'viewing';

interface Props {
  onSave: (item: StoredItem) => void;
  isVocabSaved: (vocab: VocabCard) => boolean;
  onSearch: (text: string) => void;
  isOnline: boolean;
}

export const GlobalSearch: React.FC<Props> = ({ onSave, isVocabSaved, onSearch, isOnline }) => {
  const [mode, setMode] = useState<Mode>('idle');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchGenRef = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_THRESHOLD = 50;

  // Listen for programmatic search triggers (e.g., from inline highlighted words)
  useEffect(() => {
    const handleTrigger = (e: Event) => {
      const q = (e as CustomEvent).detail?.query;
      if (q && typeof q === 'string') {
        setQuery(q);
        setMode('searching');
        setError(null);
        setResults(null);
        setCurrentIndex(0);
        // Trigger search after state updates
        setTimeout(() => {
          searchGenRef.current++;
          const currentGenId = searchGenRef.current;
          analyzeInput(q).then(result => {
            if (searchGenRef.current !== currentGenId) return;
            setResults(result);
            setMode('ready');
            if (result.vocabs?.length > 0) speak(result.vocabs[0].word || q);
            result.vocabs?.forEach(async (vocab, index) => {
              if (vocab.imagePrompt && !vocab.imageUrl) {
                try {
                  const imageData = await generateIllustration(vocab.imagePrompt, '16:9');
                  if (searchGenRef.current !== currentGenId) return;
                  if (imageData) {
                    setResults(prev => {
                      if (!prev?.vocabs) return prev;
                      const updated = [...prev.vocabs];
                      if (updated[index]) updated[index] = { ...updated[index], imageUrl: imageData };
                      return { ...prev, vocabs: updated };
                    });
                  }
                } catch {}
              }
            });
          }).catch(err => {
            if (searchGenRef.current !== currentGenId) return;
            setError(err.message || 'Search failed');
            setMode('idle');
            setTimeout(() => setError(null), 3000);
          });
        }, 0);
      }
    };
    window.addEventListener('global-search', handleTrigger);
    return () => window.removeEventListener('global-search', handleTrigger);
  }, []);

  // Cmd+F / Ctrl+F keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (mode === 'input') {
          // Already in input mode — just re-focus
          inputRef.current?.focus();
        } else {
          setMode('input');
        }
      }
      if (e.key === 'Escape') {
        if (mode === 'input') {
          e.preventDefault();
          e.stopImmediatePropagation();
          setMode(results ? 'ready' : 'idle');
        } else if (mode === 'viewing') {
          e.preventDefault();
          e.stopImmediatePropagation();
          setMode('idle');
        }
      }
      // Arrow key navigation in results popup
      if (mode === 'viewing' && results?.vocabs && results.vocabs.length > 1) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (currentIndex > 0) {
            setCurrentIndex(currentIndex - 1);
            if (results.vocabs[currentIndex - 1]?.word) speak(results.vocabs[currentIndex - 1].word);
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          const next = (currentIndex + 1) % results.vocabs.length;
          setCurrentIndex(next);
          if (results.vocabs[next]?.word) speak(results.vocabs[next].word);
        }
      }
    };
    // Use capture phase so we intercept before DetailView/App handlers
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [mode, results, currentIndex]);

  // Auto-focus input when entering input mode
  useEffect(() => {
    if (mode === 'input') {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [mode]);

  const handleSubmit = useCallback(async () => {
    const q = query.trim();
    if (!q || !isOnline) return;

    setMode('searching');
    setError(null);
    setResults(null);
    setCurrentIndex(0);

    const currentGenId = ++searchGenRef.current;

    try {
      log(`🔍 Global search: "${q}"`);
      const result = await analyzeInput(q);
      if (searchGenRef.current !== currentGenId) return;

      setResults(result);
      setMode('ready');

      // Auto-pronounce
      if (result.vocabs?.length > 0) {
        speak(result.vocabs[0].word || q);
      }

      // Generate images asynchronously
      result.vocabs?.forEach(async (vocab, index) => {
        if (vocab.imagePrompt && !vocab.imageUrl) {
          try {
            const imageData = await generateIllustration(vocab.imagePrompt, '16:9');
            if (searchGenRef.current !== currentGenId) return;
            if (imageData) {
              setResults(prev => {
                if (!prev?.vocabs) return prev;
                const updated = [...prev.vocabs];
                if (updated[index]) {
                  updated[index] = { ...updated[index], imageUrl: imageData };
                }
                return { ...prev, vocabs: updated };
              });
            }
          } catch (e) {
            warn('Global search image gen failed:', e);
          }
        }
      });
    } catch (err: any) {
      if (searchGenRef.current !== currentGenId) return;
      setError(err.message || 'Search failed');
      setMode('idle');
      setTimeout(() => setError(null), 3000);
    }
  }, [query, isOnline]);

  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    log('⭐ GlobalSearch: saving vocab', vocab.word, vocab.sense, 'id:', vocab.id);
    onSave({
      data: vocab,
      type: 'vocab',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
    });
  }, [onSave]);

  const navigateTo = useCallback((index: number) => {
    setCurrentIndex(index);
    if (results?.vocabs?.[index]?.word) {
      speak(results.vocabs[index].word);
    }
  }, [results]);

  const totalItems = results?.vocabs?.length || 0;

  // Touch handlers for swipe navigation in results popup
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current || totalItems <= 1) return;
    const diffX = e.changedTouches[0].clientX - touchStart.current.x;
    const diffY = e.changedTouches[0].clientY - touchStart.current.y;
    if (Math.abs(diffX) > Math.abs(diffY) * 1.5 && Math.abs(diffX) > SWIPE_THRESHOLD) {
      if (diffX < 0) {
        navigateTo((currentIndex + 1) % totalItems);
      } else if (currentIndex > 0) {
        navigateTo(currentIndex - 1);
      }
    }
    touchStart.current = null;
  };

  const handleFloatingClick = () => {
    if (mode === 'idle') {
      setMode('input');
    } else if (mode === 'ready') {
      setMode('viewing');
      setCurrentIndex(0);
      if (results?.vocabs?.[0]?.word) {
        speak(results.vocabs[0].word);
      }
    } else if (mode === 'searching') {
      // Do nothing while searching — show spinner
    }
  };

  const handleClose = () => {
    setMode('idle');
    setResults(null);
    setQuery('');
  };

  const currentVocab = results?.vocabs?.[currentIndex];

  return (
    <>
      {/* Error toast */}
      {error && (
        <div className="fixed bottom-28 right-4 z-[56] bg-red-50 text-red-600 text-xs font-medium px-3 py-2 rounded-lg shadow-lg animate-in fade-in duration-200">
          {error}
        </div>
      )}

      {/* Input overlay */}
      {mode === 'input' && (
        <div className="fixed bottom-20 right-4 left-4 z-[56] animate-in slide-in-from-bottom-2 duration-200">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 flex items-center gap-2 px-4 py-3 max-w-md ml-auto">
            <Search size={18} className="text-slate-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && query.trim()) {
                  e.preventDefault();
                  handleSubmit();
                }
                if (e.key === 'Escape') {
                  setMode(results ? 'ready' : 'idle');
                }
              }}
              placeholder="Look up a word..."
              className="flex-1 text-sm outline-none bg-transparent text-slate-800 placeholder:text-slate-400"
              autoComplete="off"
              autoCapitalize="off"
            />
            {query.trim() && (
              <button
                onClick={handleSubmit}
                className="shrink-0 w-8 h-8 rounded-full bg-indigo-500 text-white flex items-center justify-center hover:bg-indigo-600 transition-colors"
              >
                <Send size={14} />
              </button>
            )}
            <button
              onClick={() => setMode(results ? 'ready' : 'idle')}
              className="shrink-0 text-slate-400 hover:text-slate-600"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Results popup */}
      {mode === 'viewing' && results && currentVocab && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[54] bg-black/30 backdrop-blur-[2px] animate-in fade-in duration-150"
            onClick={handleClose}
          />
          {/* Popup */}
          <div className="fixed inset-x-0 bottom-0 z-[55] animate-in slide-in-from-bottom duration-300">
            <div className="bg-white rounded-t-3xl shadow-2xl max-h-[85vh] flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between px-5 pt-4 pb-2 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Search size={14} className="text-indigo-500" />
                  <span className="text-sm font-semibold text-slate-700">"{results.query || query}"</span>
                  {totalItems > 1 && (
                    <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                      {currentIndex + 1}/{totalItems}
                    </span>
                  )}
                </div>
                <button
                  onClick={handleClose}
                  className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Card area */}
              <div className="flex-1 overflow-y-auto overscroll-contain p-4">
                <div className="relative max-w-screen-md mx-auto">
                  {/* Navigation arrows */}
                  {totalItems > 1 && currentIndex > 0 && (
                    <button
                      onClick={() => navigateTo(currentIndex - 1)}
                      className="absolute -left-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
                    >
                      <ChevronLeft size={16} />
                    </button>
                  )}
                  {totalItems > 1 && (
                    <button
                      onClick={() => navigateTo((currentIndex + 1) % totalItems)}
                      className="absolute -right-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
                    >
                      <ChevronRight size={16} />
                    </button>
                  )}

                  <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
                    <VocabCardDisplay
                      data={currentVocab}
                      isSaved={isVocabSaved(currentVocab)}
                      onSave={() => handleSaveVocab(currentVocab)}
                      showSave={true}
                      onSearch={onSearch}
                      scrollable={false}
                      className="!h-auto !overflow-visible border-indigo-200 shadow-sm bg-white"
                    />
                  </div>

                  {/* Dot indicators */}
                  {totalItems > 1 && (
                    <div className="flex justify-center gap-1.5 mt-3">
                      {results.vocabs.map((_, idx) => (
                        <button
                          key={idx}
                          onClick={() => navigateTo(idx)}
                          className={`w-2 h-2 rounded-full transition-all ${
                            idx === currentIndex
                              ? 'bg-indigo-500 w-4'
                              : 'bg-slate-300 hover:bg-slate-400'
                          }`}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Floating button — hidden when input is open */}
      {mode !== 'input' && mode !== 'viewing' && (
        <button
          onClick={handleFloatingClick}
          className={`fixed bottom-24 right-4 z-[55] w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all duration-300
            ${mode === 'ready'
              ? 'bg-indigo-500 text-white shadow-indigo-300'
              : mode === 'searching'
              ? 'bg-white/90 text-indigo-500 border border-slate-200'
              : 'bg-white/70 text-slate-500 border border-slate-200/50 opacity-60 hover:opacity-100'
            }`}
        >
          {mode === 'searching' && (
            <Loader2 size={20} className="animate-spin" />
          )}
          {mode === 'ready' && (
            <>
              <Search size={20} />
              {/* Pulse ring */}
              <span className="absolute inset-0 rounded-full border-2 border-indigo-400 animate-ping opacity-40" />
              {/* Badge dot */}
              <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-red-500 rounded-full border-2 border-white" />
            </>
          )}
          {mode === 'idle' && (
            <Search size={20} />
          )}
        </button>
      )}
    </>
  );
};
