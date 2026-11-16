import type { ReviewRating } from '../../types';
import type { GradeReceiptText } from '../../services/studySession';

// Only the rating word is coloured, in the colour of its grade button.
const RATING_TEXT: Record<ReviewRating, string> = {
  again: 'text-rose-700',
  hard: 'text-amber-700',
  good: 'text-emerald-700',
  easy: 'text-blue-700',
};

interface GradeReceiptProps {
  /** The last grade's receipt (receiptText), or null before the first grade and after an undo. */
  receipt: GradeReceiptText | null;
  /** An undo that failed, said in the receipt's place for a few seconds. */
  error: string;
  /** Whether the last grade can still be undone, and whether an undo is under way. */
  canUndo: boolean;
  undoing: boolean;
  onUndo: () => void;
}

/**
 * The line above a study card's answer slot: which grade the last card got and when it comes back, with Undo
 * under the thumb. It keeps its 32 px from the first card on, so a grade, an undo or an error never moves the
 * card, and its 44 px Undo button reaches past it without making it taller.
 */
export function GradeReceipt({ receipt, error, canUndo, undoing, onUndo }: GradeReceiptProps) {
  return (
    <div className="h-8 flex items-center gap-2 text-xs text-slate-500">
      <div className="min-w-0 flex-1 truncate" aria-live="polite">
        {error ? (
          <span className="text-rose-700" role="alert">{error}</span>
        ) : receipt && (
          <>
            <span aria-hidden="true">↶ </span>{receipt.word} · <span className={RATING_TEXT[receipt.rating]}>{receipt.ratingLabel}</span> · {receipt.detail}
          </>
        )}
      </div>
      {canUndo && (
        <button
          type="button"
          onClick={onUndo}
          disabled={undoing}
          className="h-11 -my-1.5 shrink-0 rounded-lg px-3 text-sm font-semibold text-indigo-600 hover:bg-slate-200 disabled:opacity-50"
          aria-label="Undo last rating"
          aria-keyshortcuts="U"
          title="Undo last rating (U)"
        >
          Undo
        </button>
      )}
    </div>
  );
}
