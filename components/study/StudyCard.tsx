import { Eye, Maximize2, Undo2, Volume2, X } from 'lucide-react';
import { getItemSense, type ReviewRating, type StoredItem } from '../../types';
import { previewRatings } from '../../services/fsrsScheduler';
import { speakNatural } from '../../services/neuralTts';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { RATINGS, formatReviewInterval, getStudyContent, selectReviewTask, type StudySession } from '../../services/studySession';
import { createClozePrompt } from '../../services/studyPrompt';
import { isImeKey } from '../keyboardTarget';

const RATING_STYLES: Record<ReviewRating, string> = {
  again: 'border-rose-300 text-rose-700 bg-rose-50',
  hard: 'border-amber-300 text-amber-700 bg-amber-50',
  good: 'border-emerald-300 text-emerald-700 bg-emerald-50',
  easy: 'border-blue-300 text-blue-700 bg-blue-50',
};

interface StudyCardProps {
  session: StudySession;
  /** The card at session.index. */
  item: StoredItem;
  /** Whether the session's last grade can still be undone, and whether an undo is under way (which holds the
   *  reveal and the grades until it's done). */
  canUndo: boolean;
  undoing: boolean;
  undoError: string;
  onUndo: () => void;
  onClose: () => void;
  onReveal: () => void;
  onTypeAnswer: (text: string) => void;
  onGrade: (rating: ReviewRating) => void;
  onOpenExampleSentence: (text: string, sourceWord: string, sourceSense?: string) => void;
}

/** One card of a study session: its prompt, the answer once revealed, and the four grades. */
export function StudyCard({
  session,
  item,
  canUndo,
  undoing,
  undoError,
  onUndo,
  onClose,
  onReveal,
  onTypeAnswer,
  onGrade,
  onOpenExampleSentence,
}: StudyCardProps) {
  const task = selectReviewTask(item);
  const content = getStudyContent(item);
  const example = stripSentenceMarkers(content.example);
  // The grade buttons show each grade's next interval; they appear with the answer.
  const previews = session.revealed ? previewRatings(item.srs) : null;
  const prompt = task === 'meaning'
    ? content.word
    : task === 'production'
      ? (content.chinese || content.definition)
      : task === 'cloze'
        ? createClozePrompt(content.example, content.word)
        : '';
  return (
    <div className="max-w-2xl mx-auto min-h-full flex flex-col">
      <header className="h-14 flex items-center justify-between border-b border-slate-200">
        <span className="text-sm font-semibold text-slate-600">{session.index + 1} / {session.itemIds.length}</span>
        <span className="text-xs font-medium uppercase text-slate-400">{task}</span>
        <div className="flex items-center gap-1">
          {canUndo && (
            <button onClick={onUndo} disabled={undoing} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200 disabled:opacity-50" aria-label="Undo last rating" aria-keyshortcuts="U" title="Undo last rating">
              <Undo2 size={19} />
            </button>
          )}
          <button onClick={onClose} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="End study session"><X size={20} /></button>
        </div>
      </header>

      {undoError && <p className="mt-3 text-sm text-rose-700" role="alert">{undoError}</p>}

      <section className="flex-1 flex flex-col justify-center py-10 text-center">
        {task === 'listening' ? (
          <button
            onClick={() => speakNatural(example, { allowDownload: true })}
            className="mx-auto w-16 h-16 rounded-full bg-slate-900 text-white grid place-items-center hover:bg-slate-800"
            aria-label="Play listening prompt"
          >
            <Volume2 size={26} />
          </button>
        ) : (
          <div className={task === 'meaning' ? 'text-4xl font-bold text-slate-900' : 'text-xl leading-relaxed text-slate-800'}>{prompt}</div>
        )}

        {task === 'production' && !session.revealed && (
          <input
            autoFocus
            value={session.typedAnswer}
            onChange={event => onTypeAnswer(event.target.value)}
            onKeyDown={event => {
              // The Enter that picks an input-method candidate is not the answer.
              if (event.key === 'Enter' && !isImeKey(event.nativeEvent)) {
                event.preventDefault();
                onReveal();
              }
            }}
            className="mt-8 mx-auto w-full max-w-md h-12 px-4 rounded-lg border border-slate-300 bg-white text-center text-lg text-slate-900 focus:border-slate-600 focus:outline-none"
            aria-label="Type the recalled word"
            autoComplete="off"
            spellCheck={false}
          />
        )}

        {session.revealed ? (
          <div className="mt-10 pt-8 border-t border-slate-200 text-left" aria-live="polite">
            <div className="text-3xl font-bold text-slate-900 mb-2">{content.word}</div>
            {task === 'production' && session.typedAnswer && (
              <div className="text-sm text-slate-500 mb-3">Your answer: <span className="font-medium text-slate-700">{session.typedAnswer}</span></div>
            )}
            {content.chinese && <div className="text-lg text-slate-700 mb-2">{content.chinese}</div>}
            {content.definition && <div className="text-sm leading-relaxed text-slate-600 mb-4">{content.definition}</div>}
            {example && (
              <div className="flex items-start gap-2 border-l-2 border-slate-300 pl-3 text-sm leading-relaxed text-slate-500">
                <span className="min-w-0 flex-1 pt-1.5">{example}</span>
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation();
                    onOpenExampleSentence(content.example, content.word, getItemSense(item) || undefined);
                  }}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-200 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  aria-label="Open sentence review"
                  title="Open sentence review"
                >
                  <Maximize2 size={17} />
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={onReveal}
            disabled={undoing}
            className="mt-12 mx-auto h-12 px-6 inline-flex items-center gap-2 bg-white border border-slate-300 rounded-lg font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            aria-keyshortcuts="Space Enter"
          >
            <Eye size={18} /> Reveal answer
          </button>
        )}
      </section>

      {previews && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-slate-200 pt-4">
          {RATINGS.map((rating, i) => (
            <button
              key={rating}
              onClick={() => onGrade(rating)}
              disabled={undoing}
              aria-keyshortcuts={String(i + 1)}
              className={`h-14 rounded-lg border font-semibold capitalize disabled:opacity-50 ${RATING_STYLES[rating]}`}
            >
              <span className="block">{rating}</span>
              <span className="block text-[11px] font-normal opacity-75">{formatReviewInterval(previews[rating].interval)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
