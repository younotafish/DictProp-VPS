import { Bookmark, CheckCircle2, RotateCcw, Trash2 } from 'lucide-react';
import type { SRSData } from '../../types';
import type { MasteryClasses } from '../../components/mastery';
import { SrsStats } from './SrsStats';

interface SentenceActionsRowProps {
  srs: SRSData | undefined;
  /** The sentence's mastery and its colors; left out for a preview, which has no progress to show. */
  mastery: { label: string; percentage: number } | null;
  masteryColors: MasteryClasses | null;
  /** Sentences in this list at least 70% strong. */
  memorizedCount: number;
  /** Nothing in the library backs the sentence yet. */
  preview: boolean;
  /** A Real Life or essay sentence: Got it creates its progress record. */
  catalog: boolean;
  catalogKind: 'real-life' | 'essay' | undefined;
  onRemember: () => void;
  /** Saves an unsaved example preview; without it a preview offers nothing. */
  onSaveSentence?: () => void;
  onReset: () => void;
  onDelete: () => void;
}

/** Sentence review's bottom row: the sentence's memory on the left, and Got it, Reset and Delete (or Save) on the right. */
export function SentenceActionsRow({
  srs, mastery, masteryColors, memorizedCount, preview, catalog, catalogKind, onRemember, onSaveSentence, onReset, onDelete,
}: SentenceActionsRowProps) {
  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      {mastery && masteryColors && (
        <SrsStats srs={srs} mastery={mastery} colors={masteryColors} compact>
          <span className="text-emerald-600 flex items-center gap-0.5"><CheckCircle2 size={12} />{memorizedCount}</span>
        </SrsStats>
      )}
      <div className="ml-auto flex items-center gap-1">
        {preview ? (
          catalog ? (
            <button
              type="button"
              onClick={onRemember}
              className="flex min-h-11 items-center gap-2 rounded-md bg-emerald-500 px-4 text-sm font-bold text-white transition-colors hover:bg-emerald-600"
              title={`Remember in this ${catalogKind === 'essay' ? 'essay' : 'Real Life collection'} (R)`}
            >
              <CheckCircle2 size={17} /> Got it
            </button>
          ) : onSaveSentence && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSaveSentence();
              }}
              className="flex min-h-11 items-center gap-2 rounded-md bg-indigo-600 px-4 text-sm font-bold text-white transition-colors hover:bg-indigo-700"
              title="Save sentence for review"
            >
              <Bookmark size={17} /> Save sentence
            </button>
          )
        ) : (
          <>
            <button onClick={onReset} className="-my-1 flex h-9 w-9 items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" title="Reset memory (Shift+R)" aria-label="Reset memory">
              <RotateCcw size={15} />
            </button>
            <button onClick={onDelete} className="-my-1 flex h-9 w-9 items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="Delete sentence (D)" aria-label="Delete sentence">
              <Trash2 size={15} />
            </button>
            <button onClick={onRemember} className="-my-1 flex min-h-9 items-center gap-1 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 px-3 rounded-lg transition-colors" title="Remember (R)">
              <CheckCircle2 size={14} /> Got it
            </button>
          </>
        )}
      </div>
    </div>
  );
}
