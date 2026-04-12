import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, Loader2, Send, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { SearchResult, VocabCard, StoredItem } from '../types';
import { analyzeInput, generateIllustration } from '../services/api';
import { VocabCardDisplay } from './VocabCard';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { speak } from '../services/speech';
import { log, warn } from '../services/logger';

interface QueueItem {
  id: string;
  query: string;
  status: 'pending' | 'searching' | 'ready' | 'failed';
  results: SearchResult | null;
}

type Mode = 'idle' | 'input' | 'viewing';

interface Props {
  onSave: (item: StoredItem) => void;
  isVocabSaved: (vocab: VocabCard) => boolean;
  findSavedByWord: (word: string) => VocabCard[];
  onSearch: (text: string) => void;
  isOnline: boolean;
  activeProject?: string;
}

let queueIdCounter = 0;

export const GlobalSearch: React.FC<Props> = ({ onSave, isVocabSaved, findSavedByWord, onSearch, isOnline, activeProject }) => {
  const [mode, setMode] = useState<Mode>('idle');
  const [query, setQuery] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Viewing state: which queue item and which vocab within it
  const [viewingQueueIdx, setViewingQueueIdx] = useState(0);
  const [viewingVocabIdx, setViewingVocabIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_THRESHOLD = 50;

  // Derived state
  const readyItems = queue.filter(q => q.status === 'ready');
  const searchingCount = queue.filter(q => q.status === 'searching' || q.status === 'pending').length;
  const readyCount = readyItems.length;
  const hasWork = searchingCount > 0 || readyCount > 0;

  // Add a query to the queue
  const enqueue = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    // Don't add duplicates that are already pending/searching/ready
    setQueue(prev => {
      if (prev.some(item => item.query.toLowerCase() === trimmed.toLowerCase() && item.status !== 'failed')) {
        log('🔍 Queue: skipping duplicate "' + trimmed + '"');
        return prev;
      }
      log('🔍 Queue: adding "' + trimmed + '"');
      return [...prev, { id: `q-${++queueIdCounter}`, query: trimmed, status: 'pending', results: null }];
    });
  }, []);

  // Process queue — pick up next pending item and search it
  useEffect(() => {
    if (processingRef.current) return;
    const pending = queue.find(q => q.status === 'pending');
    if (!pending) return;

    processingRef.current = true;
    const itemId = pending.id;

    // Check if word is already saved — skip API call if so
    const savedVocabs = findSavedByWord(pending.query);
    if (savedVocabs.length > 0) {
      log('🔍 Queue: "' + pending.query + '" already saved (' + savedVocabs.length + ' meanings), skipping API');
      const cachedResult: SearchResult = {
        id: 'saved-' + itemId,
        query: pending.query,
        translation: '',
        grammar: '',
        visualKeyword: savedVocabs[0].word,
        pronunciation: savedVocabs[0].ipa || '',
        vocabs: savedVocabs,
        timestamp: Date.now(),
      };
      setQueue(prev => prev.map(q => q.id === itemId ? { ...q, status: 'ready' as const, results: cachedResult } : q));
      processingRef.current = false;
      return;
    }

    // Mark as searching
    setQueue(prev => prev.map(q => q.id === itemId ? { ...q, status: 'searching' as const } : q));

    log('🔍 Queue: searching "' + pending.query + '"');
    analyzeInput(pending.query).then(result => {
      setQueue(prev => prev.map(q => q.id === itemId ? { ...q, status: 'ready' as const, results: result } : q));
      // Generate images in background
      result.vocabs?.forEach(async (vocab, index) => {
        if (vocab.imagePrompt && !vocab.imageUrl) {
          try {
            const imageData = await generateIllustration(vocab.imagePrompt, '16:9');
            if (imageData) {
              setQueue(prev => prev.map(q => {
                if (q.id !== itemId || !q.results?.vocabs) return q;
                const updated = [...q.results.vocabs];
                if (updated[index]) updated[index] = { ...updated[index], imageUrl: imageData };
                return { ...q, results: { ...q.results, vocabs: updated } };
              }));
            }
          } catch {}
        }
      });
    }).catch(err => {
      warn('🔍 Queue: failed "' + pending.query + '":', err.message);
      setQueue(prev => prev.map(q => q.id === itemId ? { ...q, status: 'failed' as const } : q));
    }).finally(() => {
      processingRef.current = false;
    });
  }, [queue, findSavedByWord]);

  // Listen for programmatic search triggers (e.g., from inline highlighted words)
  useEffect(() => {
    const handleTrigger = (e: Event) => {
      const q = (e as CustomEvent).detail?.query;
      if (q && typeof q === 'string') {
        enqueue(q);
      }
    };
    window.addEventListener('global-search', handleTrigger);
    return () => window.removeEventListener('global-search', handleTrigger);
  }, [enqueue]);

  // Cmd+F / Ctrl+F keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (mode === 'input') {
          inputRef.current?.focus();
        } else {
          setMode('input');
        }
      }
      if (e.key === 'Escape') {
        if (mode === 'input') {
          e.preventDefault();
          e.stopImmediatePropagation();
          setMode('idle');
        } else if (mode === 'viewing') {
          e.preventDefault();
          e.stopImmediatePropagation();
          setMode('idle');
        }
      }
      // Arrow key navigation in viewing mode
      if (mode === 'viewing' && readyItems.length > 0) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        const currentResult = readyItems[viewingQueueIdx]?.results;
        const vocabCount = currentResult?.vocabs?.length || 0;
        if (e.key === 'ArrowLeft' && vocabCount > 1) {
          e.preventDefault();
          const prev = viewingVocabIdx > 0 ? viewingVocabIdx - 1 : vocabCount - 1;
          setViewingVocabIdx(prev);
          if (currentResult?.vocabs?.[prev]?.word) speak(currentResult.vocabs[prev].word);
        } else if (e.key === 'ArrowRight' && vocabCount > 1) {
          e.preventDefault();
          const next = (viewingVocabIdx + 1) % vocabCount;
          setViewingVocabIdx(next);
          if (currentResult?.vocabs?.[next]?.word) speak(currentResult.vocabs[next].word);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [mode, readyItems, viewingQueueIdx, viewingVocabIdx]);

  // Auto-focus input
  useEffect(() => {
    if (mode === 'input') {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [mode]);

  // Submit from input box — add to queue and switch to viewing once ready
  const handleSubmit = useCallback(() => {
    const q = query.trim();
    if (!q || !isOnline) return;
    enqueue(q);
    setQuery('');
    setMode('idle'); // Go back to idle — spinner shows on floating button
  }, [query, isOnline, enqueue]);

  const [saveToast, setSaveToast] = useState<string | null>(null);

  // Save a single vocab
  const saveOneVocab = useCallback((vocab: VocabCard) => {
    if (isVocabSaved(vocab)) return false; // already saved
    onSave({
      data: vocab,
      type: 'vocab',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
      ...(activeProject ? { project: activeProject } : {}),
    });
    return true;
  }, [onSave, activeProject, isVocabSaved]);

  // Save ALL meanings of a specific queue item's results
  const handleSaveWord = useCallback((result: SearchResult | null) => {
    if (!result?.vocabs?.length) return;
    let count = 0;
    for (const vocab of result.vocabs) {
      if (saveOneVocab(vocab)) count++;
    }
    if (count > 0) {
      setSaveToast(`Saved "${result.query}" (${count} ${count === 1 ? 'meaning' : 'meanings'})`);
    } else {
      setSaveToast(`"${result.query}" already saved`);
    }
    setTimeout(() => setSaveToast(null), 2000);
  }, [saveOneVocab]);

  // Save ALL meanings of ALL ready queue items
  const handleSaveAll = useCallback(() => {
    let totalCount = 0;
    let wordCount = 0;
    for (const item of readyItems) {
      if (!item.results?.vocabs?.length) continue;
      let wordSaved = false;
      for (const vocab of item.results.vocabs) {
        if (saveOneVocab(vocab)) { totalCount++; wordSaved = true; }
      }
      if (wordSaved) wordCount++;
    }
    if (totalCount > 0) {
      setSaveToast(`Saved ${totalCount} meanings from ${wordCount} ${wordCount === 1 ? 'word' : 'words'}`);
    } else {
      setSaveToast('All items already saved');
    }
    setTimeout(() => setSaveToast(null), 2000);
  }, [readyItems, saveOneVocab]);

  // Keep single-vocab save for VocabCard's internal use
  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    if (saveOneVocab(vocab)) {
      setSaveToast(`Saved "${vocab.word}"`);
      setTimeout(() => setSaveToast(null), 2000);
    }
  }, [saveOneVocab]);

  // Remove a single item from queue
  const dismissQueueItem = useCallback((id: string) => {
    setQueue(prev => prev.filter(q => q.id !== id));
    // Adjust viewing index if needed
    setViewingQueueIdx(prev => {
      const newReady = queue.filter(q => q.id !== id && q.status === 'ready');
      if (newReady.length === 0) {
        setMode('idle');
        return 0;
      }
      return Math.min(prev, newReady.length - 1);
    });
    setViewingVocabIdx(0);
  }, [queue]);

  // Clear all completed items
  const clearQueue = useCallback(() => {
    setQueue(prev => prev.filter(q => q.status === 'pending' || q.status === 'searching'));
    setMode('idle');
    setViewingQueueIdx(0);
    setViewingVocabIdx(0);
  }, []);

  const handleFloatingClick = () => {
    if (readyCount > 0) {
      // Show results
      setViewingQueueIdx(0);
      setViewingVocabIdx(0);
      setMode('viewing');
      const firstReady = readyItems[0];
      if (firstReady?.results?.vocabs?.[0]?.word) {
        speak(firstReady.results.vocabs[0].word);
      }
    } else if (searchingCount > 0) {
      // Still loading — do nothing
    } else {
      setMode('input');
    }
  };

  const handleClose = () => {
    setMode('idle');
  };

  // Touch handlers for swipe navigation in results popup
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const diffX = e.changedTouches[0].clientX - touchStart.current.x;
    const diffY = e.changedTouches[0].clientY - touchStart.current.y;
    touchStart.current = null;

    if (Math.abs(diffX) <= Math.abs(diffY) * 1.5 || Math.abs(diffX) <= SWIPE_THRESHOLD) return;

    const currentResult = readyItems[viewingQueueIdx]?.results;
    const vocabCount = currentResult?.vocabs?.length || 0;

    if (vocabCount > 1) {
      if (diffX < 0) {
        const next = (viewingVocabIdx + 1) % vocabCount;
        setViewingVocabIdx(next);
        if (currentResult?.vocabs?.[next]?.word) speak(currentResult.vocabs[next].word);
      } else if (viewingVocabIdx > 0) {
        setViewingVocabIdx(viewingVocabIdx - 1);
        if (currentResult?.vocabs?.[viewingVocabIdx - 1]?.word) speak(currentResult.vocabs[viewingVocabIdx - 1].word);
      }
    }
  };

  // Current viewing state
  const viewingItem = mode === 'viewing' ? readyItems[viewingQueueIdx] : null;
  const viewingResult = viewingItem?.results;
  const viewingVocab = viewingResult?.vocabs?.[viewingVocabIdx];
  const viewingVocabCount = viewingResult?.vocabs?.length || 0;

  return (
    <>
      {/* Save toast */}
      {saveToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-emerald-500 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg animate-in fade-in zoom-in-95 duration-200">
          {saveToast}
        </div>
      )}
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
                  setMode('idle');
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
              onClick={() => setMode('idle')}
              className="shrink-0 text-slate-400 hover:text-slate-600"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Results popup */}
      {mode === 'viewing' && viewingItem && viewingVocab && (
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
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Search size={14} className="text-indigo-500 shrink-0" />
                  <span className="text-sm font-semibold text-slate-700 truncate">"{viewingResult?.query || viewingItem.query}"</span>
                  {viewingVocabCount > 1 && (
                    <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full shrink-0">
                      {viewingVocabIdx + 1}/{viewingVocabCount}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Queue navigation — if multiple ready items */}
                  {readyItems.length > 1 && (
                    <div className="flex items-center gap-1 mr-2">
                      <button
                        onClick={() => { setViewingQueueIdx(prev => Math.max(0, prev - 1)); setViewingVocabIdx(0); }}
                        disabled={viewingQueueIdx === 0}
                        className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full">
                        {viewingQueueIdx + 1}/{readyItems.length}
                      </span>
                      <button
                        onClick={() => { setViewingQueueIdx(prev => Math.min(readyItems.length - 1, prev + 1)); setViewingVocabIdx(0); }}
                        disabled={viewingQueueIdx >= readyItems.length - 1}
                        className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  )}
                  {/* Save all meanings of current word */}
                  {(() => {
                    const allSaved = viewingResult?.vocabs?.every(v => isVocabSaved(v)) ?? false;
                    const meaningCount = viewingResult?.vocabs?.length ?? 0;
                    return (
                      <button
                        onClick={() => handleSaveWord(viewingResult)}
                        className={`h-8 px-3 rounded-full flex items-center justify-center gap-1.5 text-xs font-semibold transition-all ${
                          allSaved
                            ? 'bg-indigo-100 text-indigo-600 border border-indigo-200'
                            : 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-sm'
                        }`}
                      >
                        <Sparkles size={14} fill={allSaved ? 'currentColor' : 'none'} />
                        {allSaved ? 'All saved' : meaningCount > 1 ? `Save all ${meaningCount}` : 'Save'}
                      </button>
                    );
                  })()}
                  {/* Dismiss this result */}
                  <button
                    onClick={() => dismissQueueItem(viewingItem.id)}
                    className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
                    title="Dismiss"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Card area */}
              <div className="flex-1 overflow-y-auto overscroll-contain p-4">
                <div className="relative max-w-screen-md mx-auto">
                  {/* Navigation arrows for vocabs */}
                  {viewingVocabCount > 1 && viewingVocabIdx > 0 && (
                    <button
                      onClick={() => { setViewingVocabIdx(viewingVocabIdx - 1); }}
                      className="absolute -left-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
                    >
                      <ChevronLeft size={16} />
                    </button>
                  )}
                  {viewingVocabCount > 1 && (
                    <button
                      onClick={() => { setViewingVocabIdx((viewingVocabIdx + 1) % viewingVocabCount); }}
                      className="absolute -right-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
                    >
                      <ChevronRight size={16} />
                    </button>
                  )}

                  <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
                    <VocabCardDisplay
                      data={viewingVocab}
                      isSaved={isVocabSaved(viewingVocab)}
                      onSave={() => handleSaveVocab(viewingVocab)}
                      showSave={true}
                      onSearch={onSearch}
                      scrollable={false}
                      className="!h-auto !overflow-visible border-indigo-200 shadow-sm bg-white"
                    />
                  </div>

                  {/* Vocab dot indicators */}
                  {viewingVocabCount > 1 && (
                    <div className="flex justify-center gap-1.5 mt-3">
                      {viewingResult!.vocabs.map((_, idx) => (
                        <button
                          key={idx}
                          onClick={() => setViewingVocabIdx(idx)}
                          className={`w-2 h-2 rounded-full transition-all ${
                            idx === viewingVocabIdx
                              ? 'bg-indigo-500 w-4'
                              : 'bg-slate-300 hover:bg-slate-400'
                          }`}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Queue strip — show all ready items as tabs at bottom */}
              {readyItems.length > 1 && (
                <div className="px-4 pb-3 pt-2 border-t border-slate-100 flex gap-2 overflow-x-auto no-scrollbar">
                  {readyItems.map((item, idx) => (
                    <button
                      key={item.id}
                      onClick={() => { setViewingQueueIdx(idx); setViewingVocabIdx(0); }}
                      className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                        idx === viewingQueueIdx
                          ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {item.query}
                    </button>
                  ))}
                  {readyItems.length > 1 && (
                    <>
                      <button
                        onClick={handleSaveAll}
                        className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm"
                      >
                        Save all
                      </button>
                      <button
                        onClick={clearQueue}
                        className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-rose-50 text-rose-500 hover:bg-rose-100 transition-colors"
                      >
                        Clear all
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Floating button — hidden when input or viewing is open */}
      {mode !== 'input' && mode !== 'viewing' && (
        <button
          onClick={handleFloatingClick}
          className={`fixed bottom-24 right-4 z-[55] w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all duration-300
            ${readyCount > 0
              ? 'bg-indigo-500 text-white shadow-indigo-300'
              : searchingCount > 0
              ? 'bg-white/90 text-indigo-500 border border-slate-200'
              : 'bg-white/70 text-slate-500 border border-slate-200/50 opacity-60 hover:opacity-100'
            }`}
        >
          {searchingCount > 0 && (
            <>
              <Loader2 size={20} className="animate-spin" />
              {/* Count badge */}
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-indigo-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
                {searchingCount}
              </span>
            </>
          )}
          {searchingCount === 0 && readyCount > 0 && (
            <>
              <Search size={20} />
              {/* Pulse ring */}
              <span className="absolute inset-0 rounded-full border-2 border-indigo-400 animate-ping opacity-40" />
              {/* Count badge */}
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
                {readyCount}
              </span>
            </>
          )}
          {!hasWork && (
            <Search size={20} />
          )}
        </button>
      )}
    </>
  );
};
