import React, { useState, useCallback, useRef, useEffect } from 'react';
import { StoredItem, VocabCard } from '../types';
import { X, ScanText, Loader2, Check, CheckCheck, ClipboardPaste, Trash2, ChevronLeft, CircleDot, Circle, Sparkles } from 'lucide-react';
import { detectVocabulary, DetectedWord, analyzeInput, generateIllustration } from '../services/aiService';
import { SRSAlgorithm } from '../services/srsAlgorithm';

// ─── Types ──────────────────────────────────────────────────────────────────

type AnalyzerStep = 'input' | 'selecting' | 'analyzing' | 'done';

interface AnalyzedResult {
  word: string;
  vocabCount: number;
  error?: string;
}

// ─── Level Badge Colors ─────────────────────────────────────────────────────

const levelColors: Record<string, string> = {
  'C1': 'bg-amber-100 text-amber-700 border-amber-200',
  'C2': 'bg-rose-100 text-rose-700 border-rose-200',
  'idiom': 'bg-violet-100 text-violet-700 border-violet-200',
  'phrasal verb': 'bg-blue-100 text-blue-700 border-blue-200',
  'formal': 'bg-slate-100 text-slate-600 border-slate-200',
  'academic': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'literary': 'bg-purple-100 text-purple-700 border-purple-200',
};

const getLevelColor = (level: string) => {
  const key = level.toLowerCase().trim();
  return levelColors[key] || 'bg-slate-100 text-slate-600 border-slate-200';
};

// ─── Word Checklist Item ────────────────────────────────────────────────────

const WordCheckItem: React.FC<{
  word: DetectedWord;
  isSelected: boolean;
  onToggle: () => void;
}> = ({ word, isSelected, onToggle }) => (
  <button
    onClick={onToggle}
    className={`w-full text-left p-3 rounded-xl border transition-all active:scale-[0.99] ${
      isSelected
        ? 'bg-indigo-50/60 border-indigo-200 shadow-sm'
        : 'bg-white border-slate-100 opacity-60'
    }`}
  >
    <div className="flex items-start gap-3">
      {/* Checkbox */}
      <div className="mt-0.5 shrink-0">
        {isSelected ? (
          <CircleDot size={20} className="text-indigo-600" />
        ) : (
          <Circle size={20} className="text-slate-300" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-slate-800">{word.word}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${getLevelColor(word.level)}`}>
            {word.level}
          </span>
        </div>
        <p className="text-xs text-slate-400 mt-0.5 italic leading-relaxed line-clamp-2">
          "...{word.context}..."
        </p>
        <p className="text-xs text-slate-500 mt-1 leading-relaxed">{word.reason}</p>
      </div>
    </div>
  </button>
);

// ─── Main Component ─────────────────────────────────────────────────────────

interface TextAnalyzerProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (item: StoredItem) => void;
  onUpdateStoredItem?: (item: StoredItem) => void;
  savedItems: StoredItem[];
  isOnline: boolean;
}

export const TextAnalyzer: React.FC<TextAnalyzerProps> = ({
  isOpen,
  onClose,
  onSave,
  onUpdateStoredItem,
  savedItems,
  isOnline,
}) => {
  // ── State ───────────────────────────────────────────────────────────────
  const [step, setStep] = useState<AnalyzerStep>('input');
  const [inputText, setInputText] = useState('');

  // Step 1: Detection
  const [isScanning, setIsScanning] = useState(false);
  const [detectedWords, setDetectedWords] = useState<DetectedWord[]>([]);
  const [selectedWords, setSelectedWords] = useState<Set<string>>(new Set());
  const [scanError, setScanError] = useState<string | null>(null);

  // Step 2: Analysis
  const [analysisCurrent, setAnalysisCurrent] = useState(0);
  const [analysisTotal, setAnalysisTotal] = useState(0);
  const [currentAnalyzingWord, setCurrentAnalyzingWord] = useState('');
  const [analyzedResults, setAnalyzedResults] = useState<AnalyzedResult[]>([]);
  const [totalVocabsSaved, setTotalVocabsSaved] = useState(0);
  const abortRef = useRef(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on open
  useEffect(() => {
    if (isOpen && step === 'input' && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 200);
    }
  }, [isOpen, step]);

  // ── Step 1: Scan ─────────────────────────────────────────────────────────

  const handleScan = useCallback(async () => {
    if (!inputText.trim() || isScanning || !isOnline) return;

    setIsScanning(true);
    setScanError(null);
    setDetectedWords([]);
    setSelectedWords(new Set());

    try {
      const words = await detectVocabulary(inputText);
      setDetectedWords(words);
      // All selected by default
      setSelectedWords(new Set(words.map(w => w.word)));
      setStep('selecting');
    } catch (err: any) {
      const msg = err.message || 'Scanning failed';
      setScanError(msg === 'QUOTA_EXCEEDED' ? 'AI quota exceeded. Please try again later.' : msg);
    } finally {
      setIsScanning(false);
    }
  }, [inputText, isScanning, isOnline]);

  // ── Selection Helpers ─────────────────────────────────────────────────────

  const toggleWord = useCallback((word: string) => {
    setSelectedWords(prev => {
      const next = new Set(prev);
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selectedWords.size === detectedWords.length) {
      setSelectedWords(new Set());
    } else {
      setSelectedWords(new Set(detectedWords.map(w => w.word)));
    }
  }, [selectedWords.size, detectedWords]);

  // ── Step 2: Analyze & Save ───────────────────────────────────────────────

  const handleAnalyzeAndSave = useCallback(async () => {
    const wordsToAnalyze = detectedWords.filter(w => selectedWords.has(w.word));
    if (wordsToAnalyze.length === 0) return;

    setStep('analyzing');
    setAnalysisCurrent(0);
    setAnalysisTotal(wordsToAnalyze.length);
    setAnalyzedResults([]);
    setTotalVocabsSaved(0);
    abortRef.current = false;

    let savedCount = 0;

    for (let i = 0; i < wordsToAnalyze.length; i++) {
      if (abortRef.current) break;

      const detected = wordsToAnalyze[i];
      setCurrentAnalyzingWord(detected.word);
      setAnalysisCurrent(i + 1);

      try {
        // Call the existing full AI analysis (word mode — returns all meanings)
        const result = await analyzeInput(detected.word);

        // Auto-save each vocab card
        let wordSaved = 0;
        for (const vocab of result.vocabs || []) {
          // Check if already saved (by word + sense)
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
            savedCount++;

            // Fire-and-forget image generation (one at a time, not all at once)
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

        setAnalyzedResults(prev => [...prev, {
          word: detected.word,
          vocabCount: result.vocabs?.length || 0,
        }]);
        setTotalVocabsSaved(savedCount);
      } catch (err: any) {
        setAnalyzedResults(prev => [...prev, {
          word: detected.word,
          vocabCount: 0,
          error: err.message || 'Failed',
        }]);
      }

      // Small delay between API calls to avoid rate-limiting
      if (i < wordsToAnalyze.length - 1 && !abortRef.current) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    setStep('done');
  }, [detectedWords, selectedWords, savedItems, onSave, onUpdateStoredItem]);

  // ── Navigation ─────────────────────────────────────────────────────────

  const handleBackToInput = useCallback(() => {
    setStep('input');
    setDetectedWords([]);
    setSelectedWords(new Set());
    setScanError(null);
  }, []);

  const handleBackToSelection = useCallback(() => {
    setStep('selecting');
  }, []);

  const handleStartOver = useCallback(() => {
    setInputText('');
    setStep('input');
    setDetectedWords([]);
    setSelectedWords(new Set());
    setScanError(null);
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
      handleScan();
    }
  }, [handleScan]);

  if (!isOpen) return null;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col animate-in slide-in-from-bottom duration-300">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-200 bg-white/90 backdrop-blur-md flex items-center gap-3">
        {step === 'selecting' ? (
          <button
            onClick={handleBackToInput}
            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
        ) : step === 'input' || step === 'done' ? (
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors"
          >
            <X size={20} />
          </button>
        ) : null}

        <div className="flex-1">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <ScanText size={20} className="text-violet-600" />
            Text Analyzer
          </h2>
          {step === 'selecting' && (
            <p className="text-xs text-slate-400 mt-0.5">Select words to analyze in depth</p>
          )}
          {step === 'analyzing' && (
            <p className="text-xs text-violet-500 mt-0.5 font-medium">
              Analyzing {analysisCurrent}/{analysisTotal}...
            </p>
          )}
        </div>
      </div>

      {/* ─── Content ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">

        {/* ══════ STEP 1: INPUT ══════ */}
        {step === 'input' && (
          <div className="px-4 pt-4 pb-8">
            {/* Textarea */}
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Paste a paragraph, article excerpt, or any English text here...

The AI will identify rare vocabulary, idioms, and advanced expressions for you to review."
                className="w-full min-h-[140px] max-h-[300px] p-4 pr-12 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all resize-y leading-relaxed"
                disabled={isScanning}
              />
              <div className="absolute top-2 right-2 flex flex-col gap-1">
                {!inputText && (
                  <button onClick={handlePaste} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-violet-600 hover:bg-violet-50 transition-colors" title="Paste">
                    <ClipboardPaste size={16} />
                  </button>
                )}
                {inputText && !isScanning && (
                  <button onClick={() => setInputText('')} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors" title="Clear">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* Scan Button */}
            <button
              onClick={handleScan}
              disabled={!inputText.trim() || isScanning || !isOnline}
              className={`w-full mt-3 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all ${
                !inputText.trim() || !isOnline
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : isScanning
                    ? 'bg-violet-100 text-violet-600 cursor-wait'
                    : 'bg-violet-600 hover:bg-violet-700 text-white active:scale-[0.98] shadow-sm'
              }`}
            >
              {isScanning ? (
                <><Loader2 className="animate-spin" size={16} /> Scanning for vocabulary...</>
              ) : (
                <><ScanText size={16} /> Scan Text</>
              )}
            </button>

            {inputText.trim() && !isScanning && (
              <p className="text-[11px] text-slate-400 mt-2 text-center">
                {inputText.trim().split(/\s+/).length} words &middot; {(navigator as any).userAgentData?.platform === 'macOS' || navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter
              </p>
            )}

            {!isOnline && (
              <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2 mt-2 text-center">
                Offline. Text analysis requires an internet connection.
              </p>
            )}

            {/* Error */}
            {scanError && (
              <div className="mt-3 px-4 py-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-center justify-between gap-3">
                <span>{scanError}</span>
                <button onClick={handleScan} className="px-3 py-1.5 bg-rose-100 hover:bg-rose-200 rounded-lg text-rose-700 text-xs font-semibold transition-colors shrink-0">
                  Retry
                </button>
              </div>
            )}

            {/* Loading animation */}
            {isScanning && (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="relative">
                  <div className="w-16 h-16 rounded-2xl bg-violet-100 flex items-center justify-center">
                    <ScanText size={28} className="text-violet-600 animate-pulse" />
                  </div>
                  <div className="absolute -top-1 -right-1 w-5 h-5 bg-violet-500 rounded-full flex items-center justify-center">
                    <Loader2 size={12} className="text-white animate-spin" />
                  </div>
                </div>
                <p className="text-sm font-medium text-slate-600 mt-4">Scanning for interesting vocabulary...</p>
                <p className="text-xs text-slate-400 mt-1">This takes a few seconds</p>
              </div>
            )}

            {/* Empty state hints */}
            {!inputText.trim() && !isScanning && (
              <div className="flex flex-col items-center py-12 px-6 text-center">
                <div className="w-20 h-20 bg-violet-50 rounded-full flex items-center justify-center mb-5">
                  <ScanText size={32} className="text-violet-300" />
                </div>
                <h3 className="text-lg font-bold text-slate-700 mb-2">Paste any English text</h3>
                <p className="text-sm text-slate-400 max-w-xs leading-relaxed">
                  The AI will detect advanced vocabulary and expressions. You choose which ones to study.
                </p>
                <div className="mt-6 space-y-1.5 text-left w-full max-w-xs">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Try pasting:</p>
                  {['A paragraph from a novel or article', 'Song lyrics or movie dialogue', 'An academic paper excerpt', 'A news article'].map((hint, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-300 shrink-0" />
                      {hint}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════ STEP 2: SELECT WORDS ══════ */}
        {step === 'selecting' && (
          <div className="px-4 pt-3 pb-[calc(6rem+env(safe-area-inset-bottom))]">
            {/* Select All toggle */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                {detectedWords.length} {detectedWords.length === 1 ? 'word' : 'words'} detected
              </span>
              <button
                onClick={toggleAll}
                className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 transition-colors px-2 py-1 rounded-lg hover:bg-indigo-50"
              >
                <CheckCheck size={14} />
                {selectedWords.size === detectedWords.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            {/* Word List */}
            <div className="space-y-2">
              {detectedWords.map((word) => (
                <WordCheckItem
                  key={word.word}
                  word={word}
                  isSelected={selectedWords.has(word.word)}
                  onToggle={() => toggleWord(word.word)}
                />
              ))}
            </div>

            {/* Bottom CTA */}
            <div className="fixed bottom-0 left-0 right-0 z-10 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] bg-gradient-to-t from-white via-white to-transparent">
              <button
                onClick={handleAnalyzeAndSave}
                disabled={selectedWords.size === 0}
                className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl font-bold text-sm transition-all ${
                  selectedWords.size === 0
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white active:scale-[0.98] shadow-lg'
                }`}
              >
                <Sparkles size={16} />
                Analyze & Save {selectedWords.size > 0 ? `(${selectedWords.size})` : ''}
              </button>
              <p className="text-[10px] text-slate-400 text-center mt-2">
                Each word will be fully analyzed with all meanings and saved to your notebook
              </p>
            </div>
          </div>
        )}

        {/* ══════ STEP 3: ANALYZING ══════ */}
        {step === 'analyzing' && (
          <div className="px-4 pt-6 pb-8">
            {/* Progress bar */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-slate-700">
                  Analyzing: <span className="text-indigo-600">{currentAnalyzingWord}</span>
                </span>
                <span className="text-xs font-bold text-slate-400">
                  {analysisCurrent}/{analysisTotal}
                </span>
              </div>
              <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${(analysisCurrent / analysisTotal) * 100}%` }}
                />
              </div>
            </div>

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

              {/* Currently analyzing indicator */}
              {analysisCurrent <= analysisTotal && analyzedResults.length < analysisTotal && (
                <div className="flex items-center gap-3 p-3 rounded-xl border border-indigo-200 bg-indigo-50">
                  <Loader2 size={16} className="text-indigo-500 animate-spin shrink-0" />
                  <span className="text-sm font-medium text-indigo-700">{currentAnalyzingWord}...</span>
                </div>
              )}
            </div>

            {/* Cancel button */}
            <button
              onClick={() => { abortRef.current = true; }}
              className="mt-6 w-full py-2.5 text-sm text-slate-500 hover:text-slate-700 font-medium transition-colors"
            >
              Stop after current word
            </button>
          </div>
        )}

        {/* ══════ STEP 4: DONE ══════ */}
        {step === 'done' && (
          <div className="px-4 pt-8 pb-8">
            {/* Success summary */}
            <div className="flex flex-col items-center text-center mb-8">
              <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
                <Check size={36} className="text-emerald-600" strokeWidth={3} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-1">Analysis Complete</h3>
              <p className="text-sm text-slate-500">
                {totalVocabsSaved > 0 ? (
                  <><span className="font-bold text-indigo-600">{totalVocabsSaved}</span> vocab cards saved to your notebook</>
                ) : (
                  'All words were already in your notebook'
                )}
              </p>
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
              <button
                onClick={handleStartOver}
                className="w-full py-3 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded-xl transition-colors active:scale-[0.98]"
              >
                Analyze Another Text
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
