import { ArrowLeft, BookOpenText, Loader2, Lock, MessageSquareQuote } from 'lucide-react';
import type { LessonReviewPill } from './sentenceRowState';

interface SentenceHeaderRowProps {
  /** Auto-play is locked on: Back opens its controls instead of leaving. */
  autoPlaying: boolean;
  exitLabel: string;
  onExit: () => void;
  onOpenAnalysis: () => void;
  /** The sentence's analysis is still loading: the analysis button shows a spinner in its place. */
  loadingLesson: boolean;
  position: number;
  total: number;
  /** What's left to review in this run (lessonReviewPill), on every sentence of it; null for an unsaved example's preview. */
  reviewPill: LessonReviewPill | null;
}

/** Sentence review's top row: Back (or the locked auto-play), the analysis page, the position and what's left to review. */
export function SentenceHeaderRow({ autoPlaying, exitLabel, onExit, onOpenAnalysis, loadingLesson, position, total, reviewPill }: SentenceHeaderRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 mb-1.5">
      <button
        onClick={onExit}
        className={`flex items-center gap-1 text-sm font-medium -ml-1 -my-2 px-1 py-2.5 rounded-lg transition-colors ${
          autoPlaying
            ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
            : 'text-slate-600 hover:text-indigo-600 hover:bg-slate-100'
        }`}
        title={autoPlaying ? 'Auto-play is locked. Open its controls to stop.' : `Back to ${exitLabel} (Esc)`}
      >
        {autoPlaying ? <Lock size={16} /> : <ArrowLeft size={18} />}
        {autoPlaying ? 'Auto-play' : exitLabel}
      </button>
      <div className="flex items-center gap-2">
        {/* While the analysis loads, a spinner takes the book's place in the same box, so nothing in the row moves. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenAnalysis(); }}
          className="-my-1 flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
          title={loadingLesson ? 'Loading analysis…' : 'Sentence analysis'}
          aria-label={loadingLesson ? 'Loading analysis…' : 'Open sentence analysis'}
        >
          {loadingLesson ? <Loader2 size={15} className="animate-spin text-indigo-500" /> : <BookOpenText size={15} />}
        </button>
        <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full">
          <MessageSquareQuote size={12} /> {position} / {total}
        </span>
        {reviewPill && (
          <span className={`text-[11px] font-semibold ${reviewPill.tone === 'amber' ? 'text-amber-600 bg-amber-50' : 'text-emerald-600 bg-emerald-50'} px-2 py-0.5 rounded-full`}>
            {reviewPill.label}
          </span>
        )}
      </div>
    </div>
  );
}
