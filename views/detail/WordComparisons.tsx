import { Scale } from 'lucide-react';
import type { StoredComparison } from '../../types';

/**
 * Saved comparisons that involve the word on screen, newest first, so a "parable vs fable" comparison shows on both
 * the parable and the fable pages.
 */
export function WordComparisons({ comparisons, onOpen }: { comparisons: StoredComparison[]; onOpen: (words: string[]) => void }) {
  return (
    <div className="max-w-3xl md:max-w-5xl lg:max-w-6xl xl:max-w-[1400px] 2xl:max-w-[1600px] mx-auto mt-5">
      <div className="flex items-center gap-2 mb-2">
        <Scale size={14} className="text-indigo-500" />
        <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Comparisons</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {comparisons.map((c) => (
          <button
            key={c.key}
            onClick={() => onOpen(c.words)}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 transition-colors"
            title="View this comparison"
          >
            {c.words.join(' vs ')}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The saved comparisons that include `title`, newest first. */
export const comparisonsInvolving = (comparisons: readonly StoredComparison[] | undefined, title: string): StoredComparison[] => {
  const normTitle = (title || '').toLowerCase().trim();
  return (comparisons || [])
    .filter((c) => c.words.some((w) => w.toLowerCase().trim() === normTitle))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};
