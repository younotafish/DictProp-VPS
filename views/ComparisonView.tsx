import React, { useState, useEffect, useCallback } from 'react';
import { ComparisonResult } from '../types';
import { ArrowLeft, Loader2, AlertTriangle, ChevronDown, ChevronUp, Lightbulb, Scale, RefreshCw } from 'lucide-react';
import { compareWords } from '../services/aiService';

// Color assignments for each word (up to 3)
const WORD_COLORS = [
  { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', pill: 'bg-indigo-100 text-indigo-700', dot: 'bg-indigo-500', light: 'bg-indigo-50/50' },
  { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', pill: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500', light: 'bg-emerald-50/50' },
  { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', pill: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500', light: 'bg-amber-50/50' },
];

interface ComparisonViewProps {
  words: string[];
  onClose: () => void;
}

export const ComparisonView: React.FC<ComparisonViewProps> = ({ words, onClose }) => {
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedDimensions, setCollapsedDimensions] = useState<Set<number>>(new Set());

  const fetchComparison = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await compareWords(words);
      setResult(data);
    } catch (err: any) {
      const msg = err.message || 'Comparison failed';
      if (msg === 'QUOTA_EXCEEDED') {
        setError('API quota exceeded. Please try again later.');
      } else {
        setError(msg);
      }
    } finally {
      setIsLoading(false);
    }
  }, [words]);

  useEffect(() => {
    fetchComparison();
  }, [fetchComparison]);

  // Note: Escape key is handled by App.tsx's global handler (closes comparisonWords state)

  const toggleDimension = (index: number) => {
    setCollapsedDimensions(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const getWordColor = (word: string) => {
    const displayWords = result?.words || words;
    const index = displayWords.findIndex(w => w.toLowerCase() === word.toLowerCase());
    return WORD_COLORS[index >= 0 ? index : 0];
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col animate-in slide-in-from-right duration-300 shadow-2xl">
      {/* Header */}
      <div className="bg-white/90 backdrop-blur-md border-b border-slate-200/60 shrink-0">
        <div className="px-4 py-3 flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1 text-slate-600 hover:text-slate-800 transition-colors -ml-1 px-2 py-1.5 rounded-lg hover:bg-slate-100"
          >
            <ArrowLeft size={20} />
            <span className="text-sm font-medium">Back</span>
          </button>

          <div className="flex-1 flex items-center justify-center gap-2 flex-wrap">
            {words.map((word, i) => (
              <React.Fragment key={word}>
                {i > 0 && <span className="text-slate-300 text-sm font-medium">vs</span>}
                <span className={`px-3 py-1 rounded-full text-sm font-bold ${WORD_COLORS[i]?.pill || WORD_COLORS[0].pill}`}>
                  {word}
                </span>
              </React.Fragment>
            ))}
          </div>

          {/* Retry button */}
          {!isLoading && (
            <button
              onClick={fetchComparison}
              className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
              title="Retry comparison"
            >
              <RefreshCw size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading State */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center h-full gap-6 p-8">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-indigo-100 flex items-center justify-center">
                <Scale size={28} className="text-indigo-500" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-white shadow-md flex items-center justify-center">
                <Loader2 size={16} className="text-indigo-500 animate-spin" />
              </div>
            </div>
            <div className="text-center">
              <h3 className="text-lg font-bold text-slate-800 mb-1">Analyzing differences...</h3>
              <p className="text-sm text-slate-500">
                Comparing <span className="font-semibold">{words.join(', ')}</span>
              </p>
            </div>

            {/* Skeleton cards */}
            <div className="w-full max-w-lg space-y-3 mt-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="bg-white rounded-xl p-4 animate-pulse">
                  <div className="h-4 bg-slate-200 rounded w-1/3 mb-3" />
                  <div className="h-3 bg-slate-100 rounded w-full mb-2" />
                  <div className="h-3 bg-slate-100 rounded w-4/5" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error State */}
        {error && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
            <div className="w-16 h-16 rounded-full bg-rose-100 flex items-center justify-center">
              <AlertTriangle size={28} className="text-rose-500" />
            </div>
            <div className="text-center max-w-sm">
              <h3 className="text-lg font-bold text-slate-800 mb-1">Comparison failed</h3>
              <p className="text-sm text-slate-500 mb-4">{error}</p>
              <button
                onClick={fetchComparison}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        )}

        {/* Results */}
        {result && !isLoading && (
          <div className="max-w-2xl mx-auto px-4 py-6 pb-[calc(4rem+env(safe-area-inset-bottom))] space-y-4">
            {/* Summary Banner */}
            <div className="bg-gradient-to-r from-indigo-500 to-violet-500 text-white rounded-2xl p-5 shadow-lg">
              <div className="flex items-start gap-3">
                <Lightbulb size={20} className="mt-0.5 shrink-0 opacity-80" />
                <div>
                  <h3 className="font-bold text-base mb-1">Key Difference</h3>
                  <p className="text-sm leading-relaxed opacity-95">{result.summary}</p>
                </div>
              </div>
            </div>

            {/* Dimension Cards */}
            {result.dimensions.map((dim, dimIndex) => {
              const isCollapsed = collapsedDimensions.has(dimIndex);
              return (
                <div key={dimIndex} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                  {/* Dimension Header */}
                  <button
                    onClick={() => toggleDimension(dimIndex)}
                    className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/50 transition-colors"
                  >
                    <h4 className="font-bold text-slate-800 text-sm">{dim.label}</h4>
                    {isCollapsed ? (
                      <ChevronDown size={18} className="text-slate-400" />
                    ) : (
                      <ChevronUp size={18} className="text-slate-400" />
                    )}
                  </button>

                  {!isCollapsed && (
                    <div className="px-5 pb-5 pt-0 space-y-3">
                      {/* Overall analysis */}
                      <p className="text-sm text-slate-600 leading-relaxed">{dim.analysis}</p>

                      {/* Per-word breakdown */}
                      <div className="space-y-2">
                        {Object.entries(dim.perWord).map(([word, description]) => {
                          const color = getWordColor(word);
                          return (
                            <div key={word} className={`rounded-xl p-3 ${color.bg} border ${color.border}`}>
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`w-2 h-2 rounded-full ${color.dot}`} />
                                <span className={`font-bold text-sm ${color.text}`}>{word}</span>
                              </div>
                              <p className="text-sm text-slate-700 leading-relaxed pl-4">{description}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Contextual Examples */}
            {result.examples.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100">
                  <h4 className="font-bold text-slate-800 text-sm">Contextual Examples</h4>
                </div>
                <div className="divide-y divide-slate-100">
                  {result.examples.map((example, exIndex) => (
                    <div key={exIndex} className="px-5 py-4">
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                        {example.context}
                      </p>
                      <div className="space-y-2">
                        {Object.entries(example.sentences).map(([word, sentence]) => {
                          const color = getWordColor(word);
                          return (
                            <div key={word} className="flex items-start gap-2.5">
                              <span className={`shrink-0 mt-1.5 w-2 h-2 rounded-full ${color.dot}`} />
                              <div>
                                <span className={`font-bold text-xs ${color.text}`}>{word}</span>
                                <p className="text-sm text-slate-700 italic leading-relaxed">"{sentence}"</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Common Mistakes */}
            {result.commonMistakes.length > 0 && (
              <div className="bg-amber-50 rounded-2xl border border-amber-200 overflow-hidden">
                <div className="px-5 py-4 border-b border-amber-200/60">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={16} className="text-amber-600" />
                    <h4 className="font-bold text-amber-800 text-sm">Common Mistakes</h4>
                  </div>
                </div>
                <div className="px-5 py-4 space-y-3">
                  {result.commonMistakes.map((mistake, i) => (
                    <div key={i} className="flex items-start gap-2.5">
                      <span className="text-amber-500 font-bold text-sm mt-0.5 shrink-0">{i + 1}.</span>
                      <p className="text-sm text-amber-900 leading-relaxed">{mistake}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Verdict */}
            {result.verdict && (
              <div className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white rounded-2xl p-5 shadow-lg">
                <div className="flex items-start gap-3">
                  <Scale size={20} className="mt-0.5 shrink-0 opacity-80" />
                  <div>
                    <h3 className="font-bold text-base mb-1">Verdict</h3>
                    <p className="text-sm leading-relaxed opacity-95">{result.verdict}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
