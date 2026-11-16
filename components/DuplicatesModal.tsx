import React, { useMemo, useState } from 'react';
import { X, GitMerge, AlertTriangle, ArrowRight } from 'lucide-react';
import type { VocabCard } from '../types';
import type { DuplicateClusterView } from '../services/duplicateClusters';
import { Button } from './Button';
import { Modal } from './Modal';

// The cluster type lives with the code that builds it; hooks/useOverlays still imports it from here.
export type { DuplicateClusterView };

interface Props {
  clusters: DuplicateClusterView[];
  onClose: () => void;
  onMerge: (merges: Array<{ baseWords: string[]; canonical: string }>) => void;
}

export const DuplicatesModal: React.FC<Props> = ({ clusters, onClose, onMerge }) => {
  // Per-cluster selection: whether to merge it, and which headword to keep. It covers every cluster, since the
  // clusters can't change while the modal is open (the notebook behind it is inert). Only a cluster with evidence
  // both ways that it's one word starts ticked.
  const [sel, setSel] = useState<Record<string, { include: boolean; canonical: string }>>(() =>
    Object.fromEntries(clusters.map(c => [c.id, { include: c.defaultInclude, canonical: c.suggestedCanonical }]))
  );

  const included = useMemo(() => clusters.filter(c => sel[c.id].include), [clusters, sel]);
  const includedCount = included.length;
  // What Merge will do: the dry runs of the ticked clusters under their chosen headwords, added up.
  const effect = useMemo(() => included.reduce((sum, c) => {
    const { relabeled, removed } = c.effects[sel[c.id].canonical] ?? { relabeled: 0, removed: 0 };
    return { relabeled: sum.relabeled + relabeled, removed: sum.removed + removed };
  }, { relabeled: 0, removed: 0 }), [included, sel]);

  const setCanonical = (id: string, canonical: string) =>
    setSel(p => ({ ...p, [id]: { ...p[id], canonical } }));
  const toggleInclude = (id: string) =>
    setSel(p => ({ ...p, [id]: { ...p[id], include: !p[id].include } }));

  const handleMerge = () => {
    onMerge(included.map(c => ({ baseWords: c.baseWords, canonical: sel[c.id].canonical })));
  };

  return (
    <Modal onClose={onClose} maxWidth="max-w-lg" panelClassName="max-h-[85vh] flex flex-col" ariaLabel="Merge duplicates">
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
            aria-label="Close duplicate merge"
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
            const include = s.include;
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
                      const isCanon = s.canonical === bw;
                      // The little badge: how many cards this base word has.
                      const n = cluster.counts[bw] ?? 0;
                      return (
                        <button
                          key={bw}
                          onClick={() => setCanonical(cluster.id, bw)}
                          disabled={!include}
                          aria-pressed={isCanon}
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
                  <span className="font-semibold text-indigo-600">{s.canonical}</span>
                </div>

                {/* Without evidence both ways these may be different words, so each one's meaning shows */}
                {!cluster.defaultInclude && (
                  <div className="mt-2 text-[12px]">
                    <p className="flex items-center gap-1.5 font-semibold text-amber-700">
                      <AlertTriangle size={12} className="shrink-0" />
                      Possibly different words
                    </p>
                    <ul className="mt-1 space-y-0.5 text-slate-500">
                      {cluster.members.map(member => (
                        <li key={member.base}>
                          <span className="font-semibold text-slate-600">{member.base}</span>
                          {member.definition && <> — {member.definition}</>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

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
            className="flex-1 border-0"
          >
            {includedCount > 0 ? (
              <span className="flex flex-col items-center leading-tight">
                <span>Merge {includedCount}</span>
                <span className="text-xs font-normal opacity-80">
                  relabels {effect.relabeled} {effect.relabeled === 1 ? 'card' : 'cards'}, removes {effect.removed}
                </span>
              </span>
            ) : 'Merge'}
          </Button>
        </div>
    </Modal>
  );
};
