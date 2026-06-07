import React, { useMemo, useState } from 'react';
import { X, GitMerge, AlertTriangle, ArrowRight } from 'lucide-react';
import { StoredItem, VocabCard } from '../types';
import { Button } from './Button';

// One cluster of variant-duplicate words (e.g. base words ["run","running"]) plus the
// actual saved cards involved and a suggested canonical headword.
export interface DuplicateClusterView {
  id: string;
  baseWords: string[];
  items: StoredItem[];
  suggestedCanonical: string;
}

interface Props {
  clusters: DuplicateClusterView[];
  onClose: () => void;
  onMerge: (merges: Array<{ baseWords: string[]; canonical: string }>) => void;
}

export const DuplicatesModal: React.FC<Props> = ({ clusters, onClose, onMerge }) => {
  // Per-cluster selection: whether to merge it, and which headword to keep.
  const [sel, setSel] = useState<Record<string, { include: boolean; canonical: string }>>(() =>
    Object.fromEntries(clusters.map(c => [c.id, { include: true, canonical: c.suggestedCanonical }]))
  );

  const includedCount = useMemo(() => clusters.filter(c => sel[c.id]?.include).length, [clusters, sel]);

  const setCanonical = (id: string, canonical: string) =>
    setSel(p => ({ ...p, [id]: { ...p[id], canonical } }));
  const toggleInclude = (id: string) =>
    setSel(p => ({ ...p, [id]: { ...p[id], include: !p[id]?.include } }));

  const handleMerge = () => {
    const merges = clusters
      .filter(c => sel[c.id]?.include)
      .map(c => ({ baseWords: c.baseWords, canonical: sel[c.id].canonical }));
    onMerge(merges);
  };

  // Count cards per base word inside a cluster (for the little badges).
  const countByWord = (cluster: DuplicateClusterView) => {
    const counts = new Map<string, number>();
    for (const it of cluster.items) {
      const w = ((it.data as VocabCard).word || '').toLowerCase().trim();
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    return counts;
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] flex items-center justify-center p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 bg-indigo-50 border-b border-indigo-100 flex justify-between items-center shrink-0">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-100 text-indigo-500 rounded-full flex items-center justify-center">
              <GitMerge size={18} />
            </div>
            Merge duplicates
            <span className="text-xs font-semibold text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-full">
              {clusters.length}
            </span>
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-white/50 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Intro + caution */}
        <div className="px-5 pt-4 shrink-0">
          <p className="text-sm text-slate-600 leading-relaxed">
            These look like the same word saved under different forms. Pick the headword to keep —
            the others fold into it (their forms are preserved, review progress is merged).
          </p>
          <div className="mt-3 flex items-start gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>Merging removes the folded-in cards. Close other open tabs/devices first so the deletions aren’t resurrected on sync.</span>
          </div>
        </div>

        {/* Cluster list */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-3">
          {clusters.map(cluster => {
            const s = sel[cluster.id];
            const counts = countByWord(cluster);
            const include = s?.include ?? true;
            return (
              <div
                key={cluster.id}
                className={`rounded-xl border p-3 transition-colors ${
                  include ? 'border-indigo-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-60'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  {/* Canonical chooser */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {cluster.baseWords.map(bw => {
                      const isCanon = (s?.canonical ?? cluster.suggestedCanonical) === bw;
                      const n = counts.get(bw) || 0;
                      return (
                        <button
                          key={bw}
                          onClick={() => setCanonical(cluster.id, bw)}
                          disabled={!include}
                          className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-all ${
                            isCanon
                              ? 'bg-indigo-500 text-white border-indigo-500 shadow-sm'
                              : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                          } ${!include ? 'cursor-not-allowed' : ''}`}
                          title={isCanon ? 'Keep this headword' : 'Keep this one instead'}
                        >
                          {bw}
                          {n > 1 && <span className="ml-1 opacity-70">·{n}</span>}
                        </button>
                      );
                    })}
                  </div>
                  {/* Include toggle */}
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 shrink-0 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={include}
                      onChange={() => toggleInclude(cluster.id)}
                      className="accent-indigo-500 w-4 h-4"
                    />
                    merge
                  </label>
                </div>

                {/* Result preview */}
                <div className="mt-2 flex items-center gap-1.5 text-[12px] text-slate-500">
                  <span className="truncate">
                    {cluster.baseWords.join(', ')}
                  </span>
                  <ArrowRight size={12} className="shrink-0 text-indigo-400" />
                  <span className="font-semibold text-indigo-600">{s?.canonical ?? cluster.suggestedCanonical}</span>
                </div>

                {/* Cards involved */}
                <div className="mt-2 flex flex-wrap gap-1">
                  {cluster.items.map(it => {
                    const c = it.data as VocabCard;
                    return (
                      <span
                        key={it.data.id}
                        className="text-[11px] text-slate-500 bg-slate-100 rounded px-1.5 py-0.5"
                      >
                        {c.word}
                        {c.sense ? <span className="text-slate-400"> · {c.sense}</span> : null}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-100 flex gap-3 shrink-0">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleMerge}
            disabled={includedCount === 0}
            className="flex-1 border-0 bg-indigo-500 hover:bg-indigo-600 shadow-indigo-200"
          >
            {includedCount > 0 ? `Merge ${includedCount}` : 'Merge'}
          </Button>
        </div>
      </div>
    </div>
  );
};
