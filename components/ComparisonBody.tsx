import React, { useState } from 'react';
import { ComparisonResult } from '../types';
import { AlertTriangle, ChevronDown, ChevronUp, Lightbulb, Scale } from 'lucide-react';

// Per-word color slots. Cycled (index % length) so a comparison of any number of words renders.
export const WORD_COLORS = [
  { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', pill: 'bg-indigo-100 text-indigo-700', dot: 'bg-indigo-500' },
  { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', pill: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
  { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', pill: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', pill: 'bg-rose-100 text-rose-700', dot: 'bg-rose-500' },
  { bg: 'bg-sky-50', text: 'text-sky-700', border: 'border-sky-200', pill: 'bg-sky-100 text-sky-700', dot: 'bg-sky-500' },
  { bg: 'bg-violet-50', text: 'text-violet-700', border: 'border-violet-200', pill: 'bg-violet-100 text-violet-700', dot: 'bg-violet-500' },
  { bg: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-200', pill: 'bg-teal-100 text-teal-700', dot: 'bg-teal-500' },
  { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', pill: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
];

export const wordColorAt = (index: number) => WORD_COLORS[(index >= 0 ? index : 0) % WORD_COLORS.length];

/**
 * Renders a comparison result (summary, dimensions, examples, mistakes, verdict). Used by the
 * bottom-right search popup so a comparison shows in the same place as a word-search result.
 * Just the body — no header/close chrome.
 */
export const ComparisonBody: React.FC<{ result: ComparisonResult }> = ({ result }) => {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setCollapsed(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });

  const colorFor = (word: string) => {
    const i = (result.words || []).findIndex(w => w.toLowerCase() === word.toLowerCase());
    return wordColorAt(i);
  };

  return (
    <div className="space-y-4">
      {/* Summary */}
      {result.summary && (
        <div className="bg-gradient-to-r from-indigo-500 to-violet-500 text-white rounded-2xl p-5 shadow-lg">
          <div className="flex items-start gap-3">
            <Lightbulb size={20} className="mt-0.5 shrink-0 opacity-80" />
            <div>
              <h3 className="font-bold text-base mb-1">Key Difference</h3>
              <p className="text-sm leading-relaxed opacity-95">{result.summary}</p>
            </div>
          </div>
        </div>
      )}

      {/* Dimensions */}
      {result.dimensions.map((dim, di) => {
        const isCollapsed = collapsed.has(di);
        return (
          <div key={di} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <button onClick={() => toggle(di)} className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/50 transition-colors">
              <h4 className="font-bold text-slate-800 text-sm">{dim.label}</h4>
              {isCollapsed ? <ChevronDown size={18} className="text-slate-400" /> : <ChevronUp size={18} className="text-slate-400" />}
            </button>
            {!isCollapsed && (
              <div className="px-5 pb-5 pt-0 space-y-3">
                <p className="text-sm text-slate-600 leading-relaxed">{dim.analysis}</p>
                <div className="space-y-2">
                  {Object.entries(dim.perWord).map(([word, desc]) => {
                    const c = colorFor(word);
                    return (
                      <div key={word} className={`rounded-xl p-3 ${c.bg} border ${c.border}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                          <span className={`font-bold text-sm ${c.text}`}>{word}</span>
                        </div>
                        <p className="text-sm text-slate-700 leading-relaxed pl-4">{desc}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Contextual examples */}
      {result.examples.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100"><h4 className="font-bold text-slate-800 text-sm">Contextual Examples</h4></div>
          <div className="divide-y divide-slate-100">
            {result.examples.map((ex, ei) => (
              <div key={ei} className="px-5 py-4">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">{ex.context}</p>
                <div className="space-y-2">
                  {Object.entries(ex.sentences).map(([word, sentence]) => {
                    const c = colorFor(word);
                    return (
                      <div key={word} className="flex items-start gap-2.5">
                        <span className={`shrink-0 mt-1.5 w-2 h-2 rounded-full ${c.dot}`} />
                        <div>
                          <span className={`font-bold text-xs ${c.text}`}>{word}</span>
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

      {/* Common mistakes */}
      {result.commonMistakes.length > 0 && (
        <div className="bg-amber-50 rounded-2xl border border-amber-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-amber-200/60">
            <div className="flex items-center gap-2"><AlertTriangle size={16} className="text-amber-600" /><h4 className="font-bold text-amber-800 text-sm">Common Mistakes</h4></div>
          </div>
          <div className="px-5 py-4 space-y-3">
            {result.commonMistakes.map((m, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <span className="text-amber-500 font-bold text-sm mt-0.5 shrink-0">{i + 1}.</span>
                <p className="text-sm text-amber-900 leading-relaxed">{m}</p>
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
            <div><h3 className="font-bold text-base mb-1">Verdict</h3><p className="text-sm leading-relaxed opacity-95">{result.verdict}</p></div>
          </div>
        </div>
      )}
    </div>
  );
};
