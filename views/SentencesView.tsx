import React, { useMemo, useState } from 'react';
import { StoredItem, isSentenceItem, SentenceData } from '../types';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { MessageSquareQuote, Check, Trash2 } from 'lucide-react';

interface SentencesViewProps {
  items: StoredItem[];
  onUpdateSRS: (itemId: string) => void;
  onDelete: (itemId: string) => void;
  onSearch: (term: string) => void;
  onScroll: (e: React.UIEvent<HTMLElement>) => void;
}

const renderSentenceText = (text: string, onSearch: (term: string) => void) =>
  (text || '').split(/\[\[(.+?)\]\]/g).map((part, i) =>
    i % 2 === 1 ? (
      <button
        key={i}
        onClick={(e) => { e.stopPropagation(); onSearch(part); }}
        className="text-emerald-600 font-semibold underline decoration-dotted decoration-emerald-300 cursor-pointer hover:bg-emerald-50 rounded px-0.5 transition-colors"
      >
        {part}
      </button>
    ) : part || null
  );

export const SentencesView: React.FC<SentencesViewProps> = ({
  items,
  onUpdateSRS,
  onDelete,
  onSearch,
  onScroll,
}) => {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Only recompute "now" when items change (when SRS state could have changed)
  const now = useMemo(() => Date.now(), [items]);

  const activeItems = useMemo(() => items.filter(s => !s.isArchived), [items]);

  const dueCount = useMemo(
    () => activeItems.filter(s => ((s.srs?.nextReview ?? 0) <= now)).length,
    [activeItems, now],
  );

  const sorted = useMemo(() =>
    [...activeItems].sort((a, b) => {
      const isDueA = ((a.srs?.nextReview ?? 0) <= now);
      const isDueB = ((b.srs?.nextReview ?? 0) <= now);
      if (isDueA !== isDueB) return isDueA ? -1 : 1;
      if (isDueA && isDueB) {
        return (a.srs?.nextReview ?? 0) - (b.srs?.nextReview ?? 0);
      }
      return (b.savedAt || 0) - (a.savedAt || 0);
    }),
    [activeItems, now],
  );

  const formatDue = (ts: number) => {
    const diff = ts - Date.now();
    if (diff <= 0) return 'due';
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return `in ${days}d`;
  };

  return (
    <div className="h-full overflow-y-auto" onScroll={onScroll}>
      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm border-b border-slate-100 px-4 py-3">
        <div className="max-w-screen-md mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquareQuote size={18} className="text-indigo-500" />
            <h2 className="font-bold text-slate-800">Sentences</h2>
            <span className="text-xs text-slate-400">{activeItems.length} saved</span>
          </div>
          {dueCount > 0 && (
            <span className="text-xs font-semibold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">
              {dueCount} due
            </span>
          )}
        </div>
      </div>

      {sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
          <MessageSquareQuote size={48} className="text-slate-200 mb-4" />
          <p className="text-slate-400 text-sm">No saved sentences yet</p>
          <p className="text-slate-300 text-xs mt-1">
            Save example sentences from vocabulary cards to review them here
          </p>
        </div>
      )}

      <div className="px-3 pb-[calc(5rem+env(safe-area-inset-bottom))] grid gap-2 w-full max-w-screen-md mx-auto mt-2">
        {sorted.map(item => {
          if (!isSentenceItem(item)) return null;
          const d = item.data as SentenceData;
          const isDue = ((item.srs?.nextReview ?? 0) <= now);
          const mastery = item.srs ? SRSAlgorithm.getMasteryLevel(item.srs) : null;
          const barColor = mastery
            ? mastery.memoryStrength >= 70
              ? 'bg-emerald-400'
              : mastery.memoryStrength >= 40
                ? 'bg-amber-400'
                : 'bg-red-400'
            : 'bg-slate-300';

          return (
            <div
              key={d.id}
              className={`relative rounded-xl border p-3 transition-colors ${isDue ? 'border-orange-200 bg-orange-50/30' : 'border-slate-100 bg-white'}`}
            >
              <div className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${barColor}`} />
              <div className="pl-3">
                <p className="text-sm text-slate-700 leading-relaxed mb-2">
                  {renderSentenceText(d.text, onSearch)}
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-indigo-500 font-medium">{d.sourceWord}</span>
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
                        onClick={() => onUpdateSRS(d.id)}
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
                          onClick={() => { onDelete(d.id); setConfirmDeleteId(null); }}
                          className="text-xs text-red-600 bg-red-50 hover:bg-red-100 px-2 py-1 rounded-lg transition-colors"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-xs text-slate-500 bg-slate-50 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(d.id)}
                        className="text-slate-300 hover:text-red-400 p-1 rounded-lg transition-colors"
                        title="Delete sentence"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
