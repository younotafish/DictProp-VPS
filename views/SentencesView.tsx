import React, { useMemo, useState, useDeferredValue } from 'react';
import { StoredItem, isSentenceItem, SentenceData } from '../types';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { MessageSquareQuote, Check, Trash2, Search, X } from 'lucide-react';
import { HighlightedSentence } from '../components/HighlightedSentence';
import { barColorFor } from '../components/mastery';
import { useSentenceSearch } from '../services/sentenceSearch';
import {
  compareSentencesByLearningPriority,
  orderSentencesForReview,
  type SentenceReviewFilter,
} from '../services/sentenceOrdering';
import { Virtuoso } from 'react-virtuoso';

interface SentencesViewProps {
  items: StoredItem[];
  onUpdateSRS: (itemId: string) => void;
  onDelete: (itemId: string) => void;
  onSearch: (term: string) => void;
  onScroll: (e: React.UIEvent<HTMLElement>) => void;
  /** Open a sentence's source card in DetailView. Receives the on-screen sorted order + clicked index. */
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
  /** Footnote support: look up a saved item for a term, and open its full card popup. */
  findSaved?: (term: string) => StoredItem | null;
  onOpenCard?: (item: StoredItem) => void;
}

export const SentencesView: React.FC<SentencesViewProps> = ({
  items,
  onUpdateSRS,
  onDelete,
  onSearch,
  onScroll,
  onOpenSentence,
  findSaved,
  onOpenCard,
}) => {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Only recompute "now" when items change (when SRS state could have changed)
  const now = useMemo(() => Date.now(), [items]);

  const activeItems = useMemo(() => items.filter(s => !s.isArchived), [items]);

  const [filter, setFilter] = useState<SentenceReviewFilter>('all');

  // Fuzzy search: narrows the list live as you type; Enter runs a real AI search of the typed text.
  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);
  const runSentenceSearch = useSentenceSearch(items);

  // Bucket each active sentence by review state — every sentence is exactly one of:
  //   unreviewed — never tapped "Reviewed" (totalReviews 0)
  //   due        — reviewed before and due again now (nextReview ≤ now)
  //   memorized  — reviewed and resting; nextReview is in the future, so no action needed right now
  const counts = useMemo(() => {
    let unreviewed = 0, due = 0, memorized = 0;
    for (const s of activeItems) {
      const reviews = s.srs?.totalReviews ?? 0;
      if (reviews === 0) unreviewed++;
      else if ((s.srs?.nextReview ?? 0) <= now) due++;
      else memorized++;
    }
    return { all: activeItems.length, unreviewed, due, memorized };
  }, [activeItems, now]);

  // Match the Notebook word-item ordering: least-memorized first (memoryStrength ASC), ties broken by
  // most-recently added (savedAt DESC — newest on top). Filtered by the selected review state first.
  const sorted = useMemo(() => {
    const q = deferredQuery.trim();
    let base: StoredItem[];
    if (q) {
      // A search overrides the review-state chips so a match surfaces regardless of the active tab.
      const matchIds = new Set(runSentenceSearch(deferredQuery).map(i => i.data.id));
      base = activeItems.filter(s => matchIds.has(s.data.id));
    } else {
      return orderSentencesForReview(activeItems, filter, now);
    }
    return base.sort(compareSentencesByLearningPriority);
  }, [activeItems, filter, now, deferredQuery, runSentenceSearch]);

  const formatDue = (ts: number) => {
    const diff = ts - Date.now();
    if (diff <= 0) return 'due';
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return `in ${days}d`;
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="z-10 shrink-0 bg-white/95 backdrop-blur-sm border-b border-slate-100 px-4 py-3">
        <div className="max-w-screen-md xl:max-w-4xl 2xl:max-w-5xl mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquareQuote size={18} className="text-indigo-500" />
              <h2 className="font-bold text-slate-800">Sentences</h2>
              <span className="text-xs text-slate-400">{activeItems.length} saved</span>
            </div>
            {(counts.unreviewed + counts.due) > 0 && (
              <span className="text-xs font-semibold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">
                {counts.unreviewed + counts.due} to review
              </span>
            )}
          </div>
          {/* Fuzzy search over saved sentences — narrows the list live; Enter runs a real AI search. */}
          <div className="relative mt-2">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQuery.trim()) { e.preventDefault(); onSearch(searchQuery.trim()); }
                if (e.key === 'Escape') setSearchQuery('');
              }}
              placeholder="Search saved sentences…"
              className="w-full pl-8 pr-8 py-2 text-sm rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:border-indigo-300 outline-none text-slate-700 placeholder:text-slate-400 transition-colors"
              autoComplete="off"
              autoCapitalize="off"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                title="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X size={15} />
              </button>
            )}
          </div>

          {/* Review-state filters — default 'all' (current status) */}
          <div className="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar">
            {([
              ['all', 'All', counts.all],
              ['unreviewed', 'Unreviewed', counts.unreviewed],
              ['due', 'Due', counts.due],
              ['memorized', 'Memorized', counts.memorized],
            ] as [SentenceReviewFilter, string, number][]).map(([key, label, count]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                title={
                  key === 'unreviewed' ? 'Never reviewed yet'
                  : key === 'due' ? 'Reviewed before and due again now'
                  : key === 'memorized' ? 'Reviewed — not due right now'
                  : 'All sentences'
                }
                className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${
                  filter === key ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {label}
                {count > 0 && (
                  <span className={`ml-1 ${filter === key ? 'text-indigo-100' : 'text-slate-400'}`}>{count}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
          <MessageSquareQuote size={48} className="text-slate-200 mb-4" />
          {deferredQuery.trim() ? (
            <>
              <p className="text-slate-400 text-sm">No sentences match “{deferredQuery.trim()}”</p>
              <p className="text-slate-300 text-xs mt-1">Press Enter to look it up with AI instead</p>
            </>
          ) : activeItems.length === 0 ? (
            <>
              <p className="text-slate-400 text-sm">No saved sentences yet</p>
              <p className="text-slate-300 text-xs mt-1">
                Type a sentence in the search box and tap the bookmark to save it, or bookmark example sentences from vocabulary cards
              </p>
            </>
          ) : (
            <p className="text-slate-400 text-sm">No {filter} sentences</p>
          )}
        </div>
      )}

      {sorted.length > 0 && <Virtuoso
        className="flex-1 min-h-0"
        data={sorted}
        overscan={400}
        onScroll={onScroll as any}
        components={{ Footer: () => <div className="h-[calc(5rem+env(safe-area-inset-bottom))]" /> }}
        itemContent={(index, item) => {
          if (!isSentenceItem(item)) return null;
          const d = item.data as SentenceData;
          const isDue = ((item.srs?.nextReview ?? 0) <= now);
          const mastery = item.srs ? SRSAlgorithm.getMasteryLevel(item.srs) : null;
          const barColor = barColorFor(mastery?.percentage);

          return (
            <div className="px-3 pt-2 w-full max-w-screen-md xl:max-w-4xl 2xl:max-w-5xl mx-auto">
            <div
              key={d.id}
              onClick={() => onOpenSentence(sorted, index)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpenSentence(sorted, index); }}
              title="Open card to study this sentence"
              className={`relative rounded-xl border p-3 transition-colors cursor-pointer hover:border-indigo-300 hover:shadow-sm ${isDue ? 'border-orange-200 bg-orange-50/30' : 'border-slate-100 bg-white'}`}
            >
              <div className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${barColor}`} />
              <div className="pl-3">
                <p className="text-sm xl:text-base text-slate-700 leading-relaxed mb-2">
                  <HighlightedSentence text={d.text} itemWord={d.sourceWord} onSearchWord={onSearch} findSaved={findSaved} onOpenCard={onOpenCard} />
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {d.sourceWord ? (
                      <span className="text-xs text-indigo-500 font-medium">{d.sourceWord}</span>
                    ) : (
                      <span className="text-xs text-violet-400 font-medium">Saved sentence</span>
                    )}
                    {d.sourceSense && (
                      <span className="text-xs text-slate-400">{d.sourceSense}</span>
                    )}
                    {!isDue && item.srs?.nextReview && (
                      <span className="text-xs text-slate-400">{formatDue(item.srs.nextReview)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {isDue && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onUpdateSRS(d.id); }}
                        className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 hover:bg-emerald-100 px-2 py-1 rounded-lg transition-colors"
                        title="Mark as reviewed"
                      >
                        <Check size={12} />
                        Reviewed
                      </button>
                    )}
                    {confirmDeleteId === d.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); onDelete(d.id); setConfirmDeleteId(null); }}
                          className="text-xs text-red-600 bg-red-50 hover:bg-red-100 px-2 py-1 rounded-lg transition-colors"
                        >
                          Delete
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                          className="text-xs text-slate-500 bg-slate-50 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(d.id); }}
                        className="text-slate-300 hover:text-red-400 p-1 rounded-lg transition-colors"
                        title="Delete sentence"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div></div>
          );
        }}
      />}
    </div>
  );
};
