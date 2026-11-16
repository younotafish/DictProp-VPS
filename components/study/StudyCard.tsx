import { useLayoutEffect } from 'react';
import { Eye, Maximize2, X } from 'lucide-react';
import { getItemSense, type ReviewRating, type StoredItem } from '../../types';
import { previewRatings } from '../../services/fsrsScheduler';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { RATINGS, formatReviewInterval, getStudyContent, selectReviewTask, type GradeReceiptText, type StudySession } from '../../services/studySession';
import { TASK_INSTRUCTIONS, judgeTypedAnswer, studyPrompt, verdictLine } from '../../services/studyPrompt';
import { isImeKey } from '../keyboardTarget';
import { PronunciationBlock } from '../PronunciationBlock';
import { SentenceSpeakerButton } from '../SentenceSpeakerButton';
import { GradeReceipt } from './GradeReceipt';

const RATING_STYLES: Record<ReviewRating, string> = {
  again: 'border-rose-300 text-rose-700 bg-rose-50',
  hard: 'border-amber-300 text-amber-700 bg-amber-50',
  good: 'border-emerald-300 text-emerald-700 bg-emerald-50',
  easy: 'border-blue-300 text-blue-700 bg-blue-50',
};

/**
 * How far the card's footer reaches above the tab bar: 0.5rem over the bar, then its border, the 2rem receipt line,
 * a 0.375rem gap and the 3.5rem slot, 103 px in all, rounded up. While a card shows, the page's notices and the
 * search button rise by it on the tabs (calc(var(--nav-h) + var(--tab-footer-h, 0px) + 0.5rem), UX-10).
 */
export const TAB_FOOTER_HEIGHT = '6.5rem';

// The typed answer's verdict: right, nearly (a typo or a synonym), or not.
const VERDICT_STYLES = { correct: 'text-emerald-700', close: 'text-amber-700', wrong: 'text-rose-700' } as const;

/** Cmd+Z, or Ctrl+Z: undo, not redo (with Shift) or another chord. */
const isUndoChord = (event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>) =>
  (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z';

interface StudyCardProps {
  session: StudySession;
  /** The card at session.index. */
  item: StoredItem;
  /** Whether the session's last grade can still be undone, and whether an undo is under way (which holds the
   *  reveal and the grades until it's done). */
  canUndo: boolean;
  undoing: boolean;
  /** The receipt line for the last grade (receiptText), or null before the first one. */
  receipt: GradeReceiptText | null;
  /** An undo that failed, said in the receipt line's place. */
  undoError: string;
  onUndo: () => void;
  onClose: () => void;
  /** Enter, or Space in an empty box, in the answer box: shows the answer at once. */
  onReveal: () => void;
  /** The footer's Show answer and grade buttons, which ignore a tap just after a reveal or a grade (acceptFooterTap). */
  onFooterReveal: () => void;
  onFooterGrade: (rating: ReviewRating) => void;
  onTypeAnswer: (text: string) => void;
  onOpenExampleSentence: (text: string, sourceWord: string, sourceSense?: string) => void;
}

/** One card of a study session: its prompt and the answer once revealed, over a footer with the receipt line and the grades. */
export function StudyCard({
  session,
  item,
  canUndo,
  undoing,
  receipt,
  undoError,
  onUndo,
  onClose,
  onReveal,
  onFooterReveal,
  onFooterGrade,
  onTypeAnswer,
  onOpenExampleSentence,
}: StudyCardProps) {
  // Set while the card is on screen; hiding the tab runs the cleanup too.
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--tab-footer-h', TAB_FOOTER_HEIGHT);
    return () => {
      root.removeProperty('--tab-footer-h');
    };
  }, []);

  const task = selectReviewTask(item);
  const content = getStudyContent(item);
  const example = stripSentenceMarkers(content.example);
  const sense = getItemSense(item);
  // The grade buttons show each grade's next interval; they appear with the answer.
  const previews = session.revealed ? previewRatings(item.srs) : null;
  const prompt = studyPrompt(content, task, session.siblingCounts[item.data.id] ?? 1);
  const verdict = task === 'production' && session.revealed
    ? verdictLine(judgeTypedAnswer(session.typedAnswer, content), content.word)
    : null;
  // How the word is said, tap to hear it: under the answer's word, and under a meaning prompt's, which shows the word.
  const pronunciation = content.ipa ? <PronunciationBlock text={content.word} ipa={content.ipa} /> : null;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 px-4 pt-4">
        <div className="max-w-2xl mx-auto h-14 flex items-center justify-between border-b border-slate-200">
          <span className="text-sm font-semibold text-slate-600">{session.index + 1} / {session.itemIds.length}</span>
          <span className="text-xs font-medium uppercase text-slate-400">{TASK_INSTRUCTIONS[task]}</span>
          <button onClick={onClose} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="End study session"><X size={20} /></button>
        </div>
      </header>

      {/* The prompt sits at the top, so showing the answer below it moves nothing; a long answer scrolls here
          while the footer stays put. Each card starts scrolled to its top. */}
      <section key={session.index} className="flex-1 min-h-0 overflow-y-auto px-4">
        <div className="max-w-2xl mx-auto pt-[8vh] pb-6 text-center">
          {task === 'listening' ? (
            // The prompt plays as the card shows (views/StudyEnhanced.tsx); this pauses, resumes or plays it again, and
            // the next card stops what it started.
            <SentenceSpeakerButton
              text={example}
              tone="dark"
              iconSize={26}
              className="mx-auto w-16 h-16 rounded-full grid place-items-center bg-slate-900 hover:bg-slate-800"
            />
          ) : (
            <>
              <div className={task === 'meaning' ? `${prompt.multiWord ? 'text-2xl' : 'text-4xl'} font-bold text-slate-900` : 'text-xl leading-relaxed text-slate-800'}>{prompt.text}</div>
              {task === 'meaning' && pronunciation && <div className="mt-3">{pronunciation}</div>}
              {prompt.sub && <div className="mt-2 text-sm text-slate-400">{prompt.sub}</div>}
              {prompt.detail && <div className="mt-2 text-sm text-slate-500">{prompt.detail}</div>}
            </>
          )}

          {task === 'production' && !session.revealed && (
            <input
              autoFocus
              value={session.typedAnswer}
              onChange={event => onTypeAnswer(event.target.value)}
              onKeyDown={event => {
                // A key the input method is using (the Enter that picks a pinyin candidate) is not the answer.
                if (isImeKey(event.nativeEvent)) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onReveal();
                  return;
                }
                // In an empty box, Space shows the answer and Cmd/Ctrl+Z undoes the last rating, as they do outside it.
                if (session.typedAnswer.trim()) return;
                if (event.key === ' ') {
                  event.preventDefault();
                  onReveal();
                } else if (isUndoChord(event) && canUndo && !undoing) {
                  event.preventDefault();
                  onUndo();
                }
              }}
              className="mt-8 mx-auto w-full max-w-md h-12 px-4 rounded-lg border border-slate-300 bg-white text-center text-lg text-slate-900 focus:border-slate-600 focus:outline-none"
              aria-label="Type the recalled word"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          )}

          {session.revealed && (
            <div className="mt-10 pt-8 border-t border-slate-200 text-left" aria-live="polite">
              <div className="text-3xl font-bold text-slate-900 mb-2">{content.word}</div>
              {pronunciation && <div className="mb-3">{pronunciation}</div>}
              {sense && <div className="text-sm text-slate-500 mb-2">{sense}</div>}
              {verdict && <div className={`text-sm font-medium mb-3 ${VERDICT_STYLES[verdict.tone]}`}>{verdict.text}</div>}
              {content.chinese && <div className="text-lg text-slate-700 mb-2">{content.chinese}</div>}
              {content.definition && <div className="text-sm leading-relaxed text-slate-600 mb-4">{content.definition}</div>}
              {example && (
                <div className="flex items-start gap-2 border-l-2 border-slate-300 pl-3 text-sm leading-relaxed text-slate-500">
                  <span className="min-w-0 flex-1 pt-1.5">{example}</span>
                  <SentenceSpeakerButton
                    text={example}
                    iconSize={17}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-md hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      onOpenExampleSentence(content.example, content.word, sense || undefined);
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
          )}
        </div>
      </section>

      {/* Above the tab bar: the receipt line, then one 56 px slot that holds Show answer, then the four grades
          in key order, so nothing under the thumb changes size or place. */}
      <footer className="shrink-0 px-4 pb-[calc(var(--nav-h,95px)+0.5rem)]">
        <div className="max-w-2xl mx-auto border-t border-slate-200">
          <GradeReceipt receipt={receipt} error={undoError} canUndo={canUndo} undoing={undoing} onUndo={onUndo} />
          {previews ? (
            <div className="mt-1.5 grid grid-cols-4 gap-2">
              {RATINGS.map((rating, i) => (
                <button
                  key={rating}
                  onClick={() => onFooterGrade(rating)}
                  disabled={undoing}
                  aria-keyshortcuts={String(i + 1)}
                  className={`h-14 rounded-lg border font-semibold capitalize disabled:opacity-50 ${RATING_STYLES[rating]}`}
                >
                  <span className="block">{rating}</span>
                  <span className="block text-[11px] font-normal opacity-75">{formatReviewInterval(previews[rating].interval)}</span>
                </button>
              ))}
            </div>
          ) : (
            <button
              onClick={onFooterReveal}
              disabled={undoing}
              className="mt-1.5 w-full h-14 inline-flex items-center justify-center gap-2 bg-white border border-slate-300 rounded-lg font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              aria-keyshortcuts="Space Enter"
            >
              <Eye size={18} /> Show answer
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
