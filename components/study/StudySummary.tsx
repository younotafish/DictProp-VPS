import { Play, Undo2, X } from 'lucide-react';
import { RATINGS, type SessionSummary } from '../../services/studySession';

/** A missed word on the summary: its card's id and title. */
export interface MissedWord {
  id: string;
  title: string;
}

interface StudySummaryProps {
  /** The session's numbers (summarizeSession). */
  summary: SessionSummary;
  /** The learner ended the session early, after a grade, rather than finishing it. */
  endedEarly: boolean;
  /** Takes up a session ended early at the card it was on; absent once no card is left. */
  onResume?: () => void;
  /** The missed words still in the library, in the order they were first missed. */
  missed: MissedWord[];
  /** Opens the card view on the missed word at `index`, with the missed words as its list. */
  onOpenMissed: (index: number) => void;
  /** Whether the session's last grade can still be undone, and whether an undo is under way. */
  canUndo: boolean;
  undoing: boolean;
  undoError: string;
  onUndo: () => void;
  /** Done, Enter, Esc or the close button: back to the dashboard. */
  onDone: () => void;
}

/**
 * The end of a study session, finished or ended early: how many cards it held and how many were reviewed, how each
 * grade was given, the words missed (each opens its card), an undo for the last grade, Resume for a session ended
 * early, and Done.
 */
export function StudySummary({ summary, endedEarly, onResume, missed, onOpenMissed, canUndo, undoing, undoError, onUndo, onDone }: StudySummaryProps) {
  const { counts: ratings, total, graded } = summary;
  const remembered = ratings.hard + ratings.good + ratings.easy;
  const prompts = remembered + ratings.again;
  return (
    <div className="max-w-xl mx-auto pt-10">
      <div className="flex items-center justify-between gap-3 mb-8">
        <h2 className="text-2xl font-bold text-slate-800">
          {endedEarly ? `Ended early · ${graded} of ${total} reviewed` : `Session complete · ${total} ${total === 1 ? 'card' : 'cards'}`}
        </h2>
        <button onClick={onDone} className="shrink-0 w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="Close session summary"><X size={20} /></button>
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
      {missed.length > 0 && (
        <section className="mb-6">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <h3 className="text-sm font-semibold text-slate-700">Missed ({missed.length})</h3>
            <button onClick={() => onOpenMissed(0)} className="text-sm font-semibold text-indigo-600 hover:text-indigo-800">Review missed words</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {missed.map((word, index) => (
              <button key={word.id} onClick={() => onOpenMissed(index)} className="px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 text-sm hover:bg-rose-100">{word.title}</button>
            ))}
          </div>
        </section>
      )}
      {canUndo && (
        <button onClick={onUndo} disabled={undoing} className="mb-3 w-full h-12 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-100 disabled:opacity-60 inline-flex items-center justify-center gap-2" aria-keyshortcuts="U">
          <Undo2 size={18} /> {undoing ? 'Undoing...' : 'Undo last rating'}
        </button>
      )}
      {undoError && <p className="mb-3 text-sm text-rose-700" role="alert">{undoError}</p>}
      {onResume && (
        <button onClick={onResume} className="mb-3 w-full h-12 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-100 inline-flex items-center justify-center gap-2" aria-keyshortcuts="R">
          <Play size={18} /> Resume
        </button>
      )}
      <button onClick={onDone} className="w-full h-12 bg-slate-900 text-white font-semibold rounded-lg hover:bg-slate-800" aria-keyshortcuts="Enter">Done</button>
    </div>
  );
}
