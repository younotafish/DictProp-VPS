import type { ReactNode } from 'react';
import { Bookmark, CheckCircle2, RotateCcw, Trash2 } from 'lucide-react';
import type { SRSData } from '../../types';
import type { MasteryClasses } from '../../components/mastery';
import { SrsStats } from '../../components/review/SrsStats';
import { sentenceRowState } from './sentenceRowState';

interface SentenceActionsRowProps {
  srs: SRSData | undefined;
  /** The sentence's mastery and its colors, shown once it has been reviewed (sentenceRowState); null until then. */
  mastery: { label: string; color: string; percentage: number } | null;
  masteryColors: MasteryClasses | null;
  /**
   * Sentences in this list memorized: reviewed, and not due again yet (memorizedCount). Null in an example's preview
   * (SentenceUnderReview's examplePreview), which has no list to count, as its header has no pill.
   */
  memorizedCount: number | null;
  /** Nothing in the library backs the sentence yet. */
  preview: boolean;
  /** A Real Life or essay sentence: Got it creates its progress record, and the lesson's lines have no Delete. */
  catalog: boolean;
  catalogKind: 'real-life' | 'essay' | undefined;
  onRemember: () => void;
  /** Saves an unsaved example preview; without it a preview offers nothing. */
  onSaveSentence?: () => void;
  /** Offered once the sentence has been reviewed (sentenceRowState); without it the row has no Reset. */
  onReset?: () => void;
  onDelete: () => void;
  /**
   * The practice pill (PracticePill), beside Got it from 640 px up. A phone's row is full already (the memory, Reset,
   * Delete and Got it), so there the hero's speaker row shows it instead (SentenceHero).
   */
  practicePill?: ReactNode;
}

// The button at the right end keeps one size in every state: its negative margins hold the row at 28 px, so neither
// it nor the sentence above moves when a first Got it or listen saves the sentence.
const PRIMARY_BUTTON = '-my-1 flex min-h-9 items-center gap-1 rounded-lg px-4 text-sm font-bold text-white transition-colors';

/**
 * Sentence review's bottom row: once the sentence has been reviewed, its memory on the left; on the right Reset (once
 * reviewed) and, outside the catalog lessons, Delete, then on wider screens the practice pill, and Got it at the right
 * end, or Save for an unsaved example.
 */
export function SentenceActionsRow({
  srs, mastery, masteryColors, memorizedCount, preview, catalog, catalogKind, onRemember, onSaveSentence, onReset, onDelete,
  practicePill,
}: SentenceActionsRowProps) {
  const { showDelete, primary } = sentenceRowState({ catalog, preview, totalReviews: srs?.totalReviews ?? 0 });
  const memorizedLabel = memorizedCount === null ? null : `${memorizedCount} memorized in this list`;
  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      {mastery && masteryColors && (
        <SrsStats srs={srs} mastery={mastery} colors={masteryColors} compact>
          {memorizedLabel && (
            <span className="text-emerald-600 flex items-center gap-0.5" role="img" aria-label={memorizedLabel} title={memorizedLabel}>
              <CheckCircle2 size={12} />{memorizedCount}
            </span>
          )}
        </SrsStats>
      )}
      <div className="ml-auto flex items-center gap-1">
        {onReset && (
          <button onClick={onReset} className="-my-1 flex h-9 w-9 items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" title="Reset memory (Shift+R)" aria-label="Reset memory">
            <RotateCcw size={15} />
          </button>
        )}
        {showDelete && (
          <button onClick={onDelete} className="-my-1 flex h-9 w-9 items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="Delete sentence (D)" aria-label="Delete sentence">
            <Trash2 size={15} />
          </button>
        )}
        {/* Outlined, it needs a little more room than the borderless icons beside it. */}
        {practicePill && <div className="mx-1 hidden sm:flex">{practicePill}</div>}
        {primary === 'got-it' ? (
          <button
            type="button"
            onClick={onRemember}
            className={`${PRIMARY_BUTTON} bg-emerald-500 hover:bg-emerald-600`}
            title={preview && catalog ? `Remember in this ${catalogKind === 'essay' ? 'essay' : 'Real Life collection'} (R)` : 'Remember (R)'}
          >
            <CheckCircle2 size={16} /> Got it
          </button>
        ) : onSaveSentence && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSaveSentence();
            }}
            className={`${PRIMARY_BUTTON} bg-indigo-600 hover:bg-indigo-700`}
            title="Save sentence for review"
          >
            <Bookmark size={16} /> Save sentence
          </button>
        )}
      </div>
    </div>
  );
}
