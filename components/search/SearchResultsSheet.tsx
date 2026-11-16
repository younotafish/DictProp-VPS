import React from 'react';
import { X, Loader2, ChevronLeft, ChevronRight, Sparkles, Scale, Search } from 'lucide-react';
import type { SearchResult, VocabCard } from '../../types';
import { ComparisonBody } from '../ComparisonBody';
import { ErrorBoundary } from '../ErrorBoundary';
import type { QueueItem } from './searchQueue';

interface Props {
  dialogRef: React.RefObject<HTMLDivElement | null>;
  /** The open result, a lookup or a comparison. */
  viewingItem: QueueItem;
  /** The meaning on screen, and how many the result has. */
  meaningIndex: number;
  meaningCount: number;
  /** Every ready result, and the open one's position among them. */
  readyItems: QueueItem[];
  resultIndex: number;
  /** Opens another result at its first meaning. */
  onShowResult: (index: number) => void;
  isVocabSaved: (vocab: VocabCard) => boolean;
  onClose: () => void;
  onSaveWord: (result: SearchResult | null) => void;
  onDismiss: (id: string) => void;
  onSaveAll: () => void;
  onClearAll: () => void;
  /** The open meaning's card (SearchVocabPane). Without one, a lookup's sheet says no card was returned. */
  children?: React.ReactNode;
}

/**
 * The results sheet: a header with the query, the meaning and result counters and the save and dismiss
 * buttons; the open comparison or meaning; and a strip of every ready result, with Save all and Clear all.
 */
export const SearchResultsSheet: React.FC<Props> = ({
  dialogRef, viewingItem, meaningIndex, meaningCount, readyItems, resultIndex, onShowResult,
  isVocabSaved, onClose, onSaveWord, onDismiss, onSaveAll, onClearAll, children,
}) => (
  <>
    {/* Backdrop */}
    <div
      className="fixed inset-0 z-[54] bg-black/30 fade-in"
      onClick={onClose}
    />
    {/* Popup */}
    <div className="fixed inset-x-0 bottom-0 z-[55]">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Search result: ${viewingItem.results?.query || viewingItem.query}`}
        className="bg-white rounded-t-3xl shadow-2xl max-h-[85dvh] flex flex-col outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2 border-b border-slate-100">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {viewingItem.kind === 'compare'
              ? <Scale size={14} className="text-indigo-500 shrink-0" />
              : <Search size={14} className="text-indigo-500 shrink-0" />}
            <span className="text-sm font-semibold text-slate-700 truncate">"{viewingItem.results?.query || viewingItem.query}"</span>
            {viewingItem.refreshing && (
              <span className="flex items-center gap-1 text-xs font-medium text-indigo-500 shrink-0">
                <Loader2 size={12} className="animate-spin" /> Refreshing…
              </span>
            )}
            {meaningCount > 1 && (
              <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full shrink-0">
                {meaningIndex + 1}/{meaningCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Queue navigation — if multiple ready items */}
            {readyItems.length > 1 && (
              <div className="flex items-center gap-1 mr-2">
                <button
                  onClick={() => onShowResult(Math.max(0, resultIndex - 1))}
                  disabled={resultIndex === 0}
                  aria-label="Previous result"
                  className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full">
                  {resultIndex + 1}/{readyItems.length}
                </span>
                <button
                  onClick={() => onShowResult(Math.min(readyItems.length - 1, resultIndex + 1))}
                  disabled={resultIndex >= readyItems.length - 1}
                  aria-label="Next result"
                  className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
            {/* Save all meanings of current word (searches only — comparisons auto-save; a lookup that came back
                without a card has nothing to save) */}
            {viewingItem.kind !== 'compare' && meaningCount > 0 && (() => {
              const allSaved = viewingItem.results?.vocabs?.every(v => isVocabSaved(v)) ?? false;
              return (
                <button
                  onClick={() => onSaveWord(viewingItem.results)}
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
              onClick={() => onDismiss(viewingItem.id)}
              className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
              title="Dismiss"
              aria-label="Dismiss this result"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Card area — onClick on THIS scroll container (not the card) so the eyes-free quarter-bands
            are anchored to the visible popup body and work regardless of how far the card is scrolled.
            The relative wrapper hosts the zone guides as a non-scrolling sibling overlay. */}
        <div className="relative flex-1 min-h-0 flex flex-col">
        {viewingItem.kind === 'compare' ? (
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4">
            <div className="max-w-screen-md mx-auto">
              {viewingItem.comparison
                ? (
                  <ErrorBoundary key={viewingItem.id} variant="inline" fallbackMessage="This comparison couldn't be displayed.">
                    <ComparisonBody result={viewingItem.comparison} />
                  </ErrorBoundary>
                )
                : <div className="text-center text-slate-400 py-12 text-sm">Comparison unavailable.</div>}
            </div>
          </div>
        ) : children ? children : (
          <div className="flex-1 grid place-items-center text-sm text-slate-400">
            No vocabulary card was returned.
          </div>
        )}
        </div>

        {/* Queue strip — show all ready items as tabs at bottom. A result not seen yet carries a dot; the open one
            is being seen, so it never does. */}
        {readyItems.length > 1 && (
          <div className="px-4 pb-3 pt-2 border-t border-slate-100 flex gap-2 overflow-x-auto no-scrollbar">
            {readyItems.map((item, idx) => (
              <button
                key={item.id}
                onClick={() => onShowResult(idx)}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  idx === resultIndex
                    ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {item.query}
                {!item.seen && idx !== resultIndex && (
                  <>
                    <span aria-hidden="true" className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-red-500 align-middle" />
                    <span className="sr-only"> (new)</span>
                  </>
                )}
              </button>
            ))}
            <>
              <button
                onClick={onSaveAll}
                className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm"
              >
                Save all
              </button>
              <button
                onClick={onClearAll}
                className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-rose-50 text-rose-500 hover:bg-rose-100 transition-colors"
              >
                Clear all
              </button>
            </>
          </div>
        )}
      </div>
    </div>
  </>
);
