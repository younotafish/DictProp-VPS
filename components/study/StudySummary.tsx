import { Undo2, X } from 'lucide-react';
import type { ReviewRating } from '../../types';
import { RATINGS } from '../../services/studySession';

interface StudySummaryProps {
  ratings: Record<ReviewRating, number>;
  /** Whether the session's last grade can still be undone, and whether an undo is under way. */
  canUndo: boolean;
  undoing: boolean;
  undoError: string;
  onUndo: () => void;
  onClose: () => void;
}

/** The end of a study session: how each grade was given, with an undo for the last one. */
export function StudySummary({ ratings, canUndo, undoing, undoError, onUndo, onClose }: StudySummaryProps) {
  const remembered = ratings.hard + ratings.good + ratings.easy;
  const prompts = remembered + ratings.again;
  return (
    <div className="max-w-xl mx-auto pt-10">
      <div className="flex items-center justify-between mb-8">
        <h2 className="text-2xl font-bold text-slate-800">Session complete</h2>
        <button onClick={onClose} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="Close session summary"><X size={20} /></button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 border-y border-slate-200 py-5 mb-6">
        {RATINGS.map(rating => (
          <div key={rating} className="text-center">
            <div className="text-2xl font-bold text-slate-800">{ratings[rating]}</div>
            <div className="text-xs capitalize text-slate-500">{rating}</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-slate-600 mb-6">Recalled {remembered} of {prompts} prompts.</p>
      {canUndo && (
        <button onClick={onUndo} disabled={undoing} className="mb-3 w-full h-12 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-100 disabled:opacity-60 inline-flex items-center justify-center gap-2" aria-keyshortcuts="U">
          <Undo2 size={18} /> {undoing ? 'Undoing...' : 'Undo last rating'}
        </button>
      )}
      {undoError && <p className="mb-3 text-sm text-rose-700" role="alert">{undoError}</p>}
      <button onClick={onClose} className="w-full h-12 bg-slate-900 text-white font-semibold rounded-lg hover:bg-slate-800">Return to study</button>
    </div>
  );
}
