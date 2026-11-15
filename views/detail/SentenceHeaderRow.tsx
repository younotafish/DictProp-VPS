import { ArrowLeft, BookOpenText, Loader2, Lock, MessageSquareQuote } from 'lucide-react';

interface SentenceHeaderRowProps {
  /** Auto-play is locked on: Back opens its controls instead of leaving. */
  autoPlaying: boolean;
  exitLabel: string;
  onExit: () => void;
  onOpenAnalysis: () => void;
  /** The sentence's lesson (analysis and picture) is still loading. */
  loadingLesson: boolean;
  position: number;
  total: number;
  /** Sentences due in this list; nothing shows at 0. */
  dueCount: number;
}

/** Sentence review's top row: Back (or the locked auto-play), the analysis page, the position and what's due. */
export function SentenceHeaderRow({ autoPlaying, exitLabel, onExit, onOpenAnalysis, loadingLesson, position, total, dueCount }: SentenceHeaderRowProps) {
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
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenAnalysis(); }}
          className="-my-1 flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
          title="Sentence analysis"
          aria-label="Open sentence analysis"
        >
          <BookOpenText size={15} />
        </button>
        {loadingLesson && (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-indigo-500">
            <Loader2 size={12} className="animate-spin" /> Loading lesson
          </span>
        )}
        <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full">
          <MessageSquareQuote size={12} /> {position} / {total}
        </span>
        {dueCount > 0 && (
          <span className="text-[11px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
            {dueCount} due
          </span>
        )}
      </div>
    </div>
  );
}
