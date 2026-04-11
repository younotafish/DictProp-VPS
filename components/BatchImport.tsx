import React, { useState, useCallback, useRef, useEffect } from 'react';
import { StoredItem, VocabCard } from '../types';
import { X, Loader2, Check, ClipboardPaste, Trash2, ListPlus, Sparkles, RotateCcw } from 'lucide-react';
import { analyzeInput, generateIllustration } from '../services/api';
import { SRSAlgorithm } from '../services/srsAlgorithm';

// ─── Types ──────────────────────────────────────────────────────────────────

type BatchStep = 'input' | 'analyzing' | 'done';

interface AnalyzedResult {
  word: string;
  vocabCount: number;
  error?: string;
}

const CONCURRENCY = 3;

// ─── Main Component ─────────────────────────────────────────────────────────

interface BatchImportProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (item: StoredItem) => void;
  onUpdateStoredItem?: (item: StoredItem) => void;
  savedItems: StoredItem[];
  isOnline: boolean;
}

export const BatchImport: React.FC<BatchImportProps> = ({
  isOpen,
  onClose,
  onSave,
  onUpdateStoredItem,
  savedItems,
  isOnline,
}) => {
  const [step, setStep] = useState<BatchStep>('input');
  const [inputText, setInputText] = useState('');

  // Analysis state
  const [completedCount, setCompletedCount] = useState(0);
  const [analysisTotal, setAnalysisTotal] = useState(0);
  const [activeWords, setActiveWords] = useState<string[]>([]);
  const [analyzedResults, setAnalyzedResults] = useState<AnalyzedResult[]>([]);
  const [totalVocabsSaved, setTotalVocabsSaved] = useState(0);
  const abortRef = useRef(false);
  const savedCountRef = useRef(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on open
  useEffect(() => {
    if (isOpen && step === 'input' && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 200);
    }
  }, [isOpen, step]);

  // ── Parse word list ──────────────────────────────────────────────────────

  const parseWords = useCallback((text: string): string[] => {
    return text
      .split(/[\n,;]+/)
      .map(w => w.trim())
      .filter(w => w.length > 0);
  }, []);

  const wordCount = inputText.trim() ? parseWords(inputText).length : 0;

  // ── Process a single word ────────────────────────────────────────────────

  const processWord = useCallback(async (word: string): Promise<AnalyzedResult> => {
    const result = await analyzeInput(word);

    let wordSaved = 0;
    for (const vocab of result.vocabs || []) {
      const vocabWord = (vocab.word || '').toLowerCase().trim();
      const alreadySaved = savedItems.some(item => {
        if (item.type !== 'vocab') return false;
        const sw = ((item.data as VocabCard).word || '').toLowerCase().trim();
        const ss = (item.data as VocabCard).sense || '';
        return sw === vocabWord && ss === vocab.sense;
      });

      if (!alreadySaved) {
        const storedItem: StoredItem = {
          data: vocab,
          type: 'vocab',
          savedAt: Date.now(),
          srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
        };
        onSave(storedItem);
        wordSaved++;
        savedCountRef.current++;

        // Fire-and-forget image generation
        if (vocab.imagePrompt && !vocab.imageUrl && onUpdateStoredItem) {
          generateIllustration(vocab.imagePrompt, '16:9')
            .then(imageData => {
              if (imageData) {
                onUpdateStoredItem({
                  ...storedItem,
                  data: { ...vocab, imageUrl: imageData },
                });
              }
            })
            .catch(() => {});
        }
      }
    }

    return { word, vocabCount: result.vocabs?.length || 0 };
  }, [savedItems, onSave, onUpdateStoredItem]);

  // ── Run batch with concurrency pool ──────────────────────────────────────

  const runBatch = useCallback(async (words: string[]) => {
    let index = 0;

    const runNext = async (): Promise<void> => {
      while (index < words.length && !abortRef.current) {
        const currentIndex = index++;
        const word = words[currentIndex];

        setActiveWords(prev => [...prev, word]);

        try {
          const result = await processWord(word);
          setAnalyzedResults(prev => [...prev, result]);
        } catch (err: any) {
          setAnalyzedResults(prev => [...prev, {
            word,
            vocabCount: 0,
            error: err.message || 'Failed',
          }]);
        }

        setActiveWords(prev => prev.filter(w => w !== word));
        setCompletedCount(prev => prev + 1);
        setTotalVocabsSaved(savedCountRef.current);
      }
    };

    // Launch concurrent workers
    const workers = Array.from({ length: Math.min(CONCURRENCY, words.length) }, () => runNext());
    await Promise.all(workers);
  }, [processWord]);

  // ── Start analysis ───────────────────────────────────────────────────────

  const handleStart = useCallback(async (wordsOverride?: string[]) => {
    const words = wordsOverride || parseWords(inputText);
    if (words.length === 0 || !isOnline) return;

    setStep('analyzing');
    setCompletedCount(0);
    setAnalysisTotal(words.length);
    setActiveWords([]);
    setAnalyzedResults([]);
    setTotalVocabsSaved(0);
    savedCountRef.current = 0;
    abortRef.current = false;

    await runBatch(words);
    setStep('done');
  }, [inputText, parseWords, isOnline, runBatch]);

  // ── Retry failed words ───────────────────────────────────────────────────

  const handleRetryFailed = useCallback(async () => {
    const failedWords = analyzedResults.filter(r => r.error).map(r => r.word);
    if (failedWords.length === 0) return;

    // Remove failed results, keep successes
    setAnalyzedResults(prev => prev.filter(r => !r.error));
    setStep('analyzing');
    setCompletedCount(prev => prev - failedWords.length);
    setActiveWords([]);
    abortRef.current = false;

    await runBatch(failedWords);
    setStep('done');
  }, [analyzedResults, runBatch]);

  // ── Navigation ─────────────────────────────────────────────────────────

  const handleStartOver = useCallback(() => {
    setInputText('');
    setStep('input');
    setAnalyzedResults([]);
    setTotalVocabsSaved(0);
  }, []);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setInputText(text);
    } catch { /* ignore */ }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleStart();
    }
  }, [handleStart]);

  if (!isOpen) return null;

  const failedCount = analyzedResults.filter(r => r.error).length;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col animate-in slide-in-from-bottom duration-300">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-200 bg-white/90 backdrop-blur-md flex items-center gap-3">
        {step === 'analyzing' ? null : (
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors"
          >
            <X size={20} />
          </button>
        )}

        <div className="flex-1">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <ListPlus size={20} className="text-indigo-600" />
            Batch Import
          </h2>
          {step === 'analyzing' && (
            <p className="text-xs text-indigo-500 mt-0.5 font-medium">
              {completedCount}/{analysisTotal} completed &middot; {activeWords.length} in progress
            </p>
          )}
        </div>
      </div>

      {/* ─── Content ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">

        {/* ══════ INPUT ══════ */}
        {step === 'input' && (
          <div className="px-4 pt-4 pb-8">
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Paste your word list here — one word or phrase per line.

Examples:
ubiquitous
serendipity
a blessing in disguise
run the gamut"
                className="w-full min-h-[200px] max-h-[400px] p-4 pr-12 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-y leading-relaxed font-mono"
              />
              <div className="absolute top-2 right-2 flex flex-col gap-1">
                {!inputText && (
                  <button onClick={handlePaste} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors" title="Paste">
                    <ClipboardPaste size={16} />
                  </button>
                )}
                {inputText && (
                  <button onClick={() => setInputText('')} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors" title="Clear">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* Start Button */}
            <button
              onClick={() => handleStart()}
              disabled={wordCount === 0 || !isOnline}
              className={`w-full mt-3 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all ${
                wordCount === 0 || !isOnline
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white active:scale-[0.98] shadow-sm'
              }`}
            >
              <Sparkles size={16} />
              Analyze & Save {wordCount > 0 ? `(${wordCount} ${wordCount === 1 ? 'word' : 'words'})` : ''}
            </button>

            {wordCount > 0 && (
              <p className="text-[11px] text-slate-400 mt-2 text-center">
                {wordCount} {wordCount === 1 ? 'word' : 'words'} detected &middot; {CONCURRENCY} at a time &middot; {(navigator as any).userAgentData?.platform === 'macOS' || navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter
              </p>
            )}

            {!isOnline && (
              <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2 mt-2 text-center">
                Offline. Batch import requires an internet connection.
              </p>
            )}

            {/* Empty state hints */}
            {!inputText.trim() && (
              <div className="flex flex-col items-center py-12 px-6 text-center">
                <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-5">
                  <ListPlus size={32} className="text-indigo-300" />
                </div>
                <h3 className="text-lg font-bold text-slate-700 mb-2">Batch Import Words</h3>
                <p className="text-sm text-slate-400 max-w-xs leading-relaxed">
                  Paste a list of words or phrases — each on its own line. The AI will analyze every one and save all meanings with images to your notebook.
                </p>
                <div className="mt-6 space-y-1.5 text-left w-full max-w-xs">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Separators:</p>
                  {['One word/phrase per line', 'Comma-separated: word1, word2', 'Semicolons also work'].map((hint, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-300 shrink-0" />
                      {hint}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════ ANALYZING ══════ */}
        {step === 'analyzing' && (
          <div className="px-4 pt-6 pb-8">
            {/* Progress bar */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-slate-700">
                  {completedCount < analysisTotal ? (
                    <>Processing <span className="text-indigo-600">{activeWords.length}</span> word{activeWords.length !== 1 ? 's' : ''} in parallel</>
                  ) : (
                    'Finishing up...'
                  )}
                </span>
                <span className="text-xs font-bold text-slate-400">
                  {completedCount}/{analysisTotal}
                </span>
              </div>
              <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${analysisTotal > 0 ? (completedCount / analysisTotal) * 100 : 0}%` }}
                />
              </div>
            </div>

            {/* Active words */}
            {activeWords.length > 0 && (
              <div className="space-y-2 mb-4">
                {activeWords.map(word => (
                  <div key={word} className="flex items-center gap-3 p-3 rounded-xl border border-indigo-200 bg-indigo-50">
                    <Loader2 size={16} className="text-indigo-500 animate-spin shrink-0" />
                    <span className="text-sm font-medium text-indigo-700">{word}...</span>
                  </div>
                ))}
              </div>
            )}

            {/* Completed words */}
            <div className="space-y-2">
              {analyzedResults.map((result, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-3 p-3 rounded-xl border animate-in slide-in-from-left duration-200 ${
                    result.error
                      ? 'bg-rose-50 border-rose-200'
                      : 'bg-emerald-50 border-emerald-200'
                  }`}
                >
                  {result.error ? (
                    <X size={16} className="text-rose-500 shrink-0" />
                  ) : (
                    <Check size={16} className="text-emerald-600 shrink-0" strokeWidth={3} />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-slate-700 text-sm">{result.word}</span>
                    {result.error ? (
                      <p className="text-xs text-rose-500 mt-0.5">{result.error}</p>
                    ) : (
                      <p className="text-xs text-emerald-600 mt-0.5">
                        {result.vocabCount} {result.vocabCount === 1 ? 'meaning' : 'meanings'} saved
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Cancel button */}
            <button
              onClick={() => { abortRef.current = true; }}
              className="mt-6 w-full py-2.5 text-sm text-slate-500 hover:text-slate-700 font-medium transition-colors"
            >
              Stop after current words
            </button>
          </div>
        )}

        {/* ══════ DONE ══════ */}
        {step === 'done' && (
          <div className="px-4 pt-8 pb-8">
            {/* Success summary */}
            <div className="flex flex-col items-center text-center mb-8">
              <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
                <Check size={36} className="text-emerald-600" strokeWidth={3} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-1">Batch Import Complete</h3>
              <p className="text-sm text-slate-500">
                {totalVocabsSaved > 0 ? (
                  <><span className="font-bold text-indigo-600">{totalVocabsSaved}</span> vocab cards saved to your notebook</>
                ) : (
                  'All words were already in your notebook'
                )}
              </p>
              {failedCount > 0 && (
                <p className="text-sm text-rose-500 mt-1">
                  {failedCount} {failedCount === 1 ? 'word' : 'words'} failed
                </p>
              )}
            </div>

            {/* Results summary */}
            <div className="space-y-2 mb-8">
              {analyzedResults.map((result, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-3 p-3 rounded-xl border ${
                    result.error ? 'bg-rose-50 border-rose-200' : 'bg-white border-slate-100'
                  }`}
                >
                  {result.error ? (
                    <X size={16} className="text-rose-500 shrink-0" />
                  ) : (
                    <Check size={16} className="text-emerald-600 shrink-0" strokeWidth={3} />
                  )}
                  <span className="font-medium text-slate-700 text-sm flex-1">{result.word}</span>
                  {result.error ? (
                    <span className="text-xs text-rose-500">{result.error}</span>
                  ) : (
                    <span className="text-xs text-slate-400">{result.vocabCount} meanings</span>
                  )}
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="space-y-3">
              {failedCount > 0 && (
                <button
                  onClick={handleRetryFailed}
                  className="w-full py-3 bg-rose-500 hover:bg-rose-600 text-white font-semibold rounded-xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2"
                >
                  <RotateCcw size={16} />
                  Retry {failedCount} Failed {failedCount === 1 ? 'Word' : 'Words'}
                </button>
              )}
              <button
                onClick={handleStartOver}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl transition-colors active:scale-[0.98]"
              >
                Import More Words
              </button>
              <button
                onClick={onClose}
                className="w-full py-3 text-slate-500 hover:text-slate-700 font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
