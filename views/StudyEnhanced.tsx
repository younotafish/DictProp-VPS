/**
 * The study tab: the progress dashboard between sessions (StudyDashboard) and the review session itself.
 *
 * Review sessions use the same item-level FSRS state and authoritative event stream as quick review.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StoredItem, getItemSense, type ReviewHistory, type ReviewRating, type ReviewTaskType } from '../types';
import { 
  BrainCircuit, 
  Eye,
  Volume2,
  Undo2,
  Maximize2,
  X,
} from 'lucide-react';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { speakNatural } from '../services/lazyTts';
import { createClozePrompt, formatReviewInterval, getStudyContent, selectReviewTask, stripStudyMarkers } from '../services/studySession';
import { StudyDashboard } from '../components/StudyDashboard';

interface StudyEnhancedProps {
  items: StoredItem[];
  reviewHistory: ReviewHistory;
  onReview: (
    itemId: string,
    rating: ReviewRating,
    context: { taskType: ReviewTaskType; durationMs: number; sessionId: string; eventId: string },
  ) => Promise<boolean>;
  onUndoReview: (eventId: string) => Promise<void>;
  onOpenExampleSentence: (text: string, sourceWord: string, sourceSense?: string) => void;
  interactionLocked?: boolean;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

interface StudySession {
  id: string;
  itemIds: string[];
  index: number;
  revealed: boolean;
  typedAnswer: string;
  promptStartedAt: number;
  ratings: Record<ReviewRating, number>;
}

interface LastGrade {
  eventId: string;
  sessionId: string;
  itemId: string;
  itemIndex: number;
  rating: ReviewRating;
  taskType: ReviewTaskType;
  durationMs: number;
  typedAnswer: string;
  status: 'syncing' | 'ready' | 'waiting' | 'undoing';
}

const emptyRatings = (): Record<ReviewRating, number> => ({ again: 0, hard: 0, good: 0, easy: 0 });
const keyboardRatings: Partial<Record<string, ReviewRating>> = {
  '1': 'again',
  '2': 'hard',
  '3': 'good',
  '4': 'easy',
};

export const StudyEnhanced: React.FC<StudyEnhancedProps> = ({ 
  items, 
  reviewHistory,
  onReview,
  onUndoReview,
  onOpenExampleSentence,
  interactionLocked = false,
  onScroll,
}) => {
  const [session, setSession] = useState<StudySession | null>(null);
  const [lastGrade, setLastGrade] = useState<LastGrade | null>(null);
  const [undoError, setUndoError] = useState('');

  const currentItem = session && session.index < session.itemIds.length
    ? items.find(item => item.data.id === session.itemIds[session.index]) || null
    : null;
  const sessionComplete = !!session && session.index >= session.itemIds.length;

  const startSession = useCallback((queue: StoredItem[]) => {
    if (queue.length === 0) return;
    setLastGrade(null);
    setUndoError('');
    setSession({
      id: crypto.randomUUID(),
      itemIds: queue.map(item => item.data.id),
      index: 0,
      revealed: false,
      typedAnswer: '',
      promptStartedAt: Date.now(),
      ratings: emptyRatings(),
    });
  }, []);

  const gradeCurrent = (rating: ReviewRating) => {
    if (!session || !currentItem || !session.revealed) return;
    const taskType = selectReviewTask(currentItem);
    const eventId = crypto.randomUUID();
    const grade: LastGrade = {
      eventId,
      sessionId: session.id,
      itemId: currentItem.data.id,
      itemIndex: session.index,
      rating,
      taskType,
      durationMs: Math.max(0, Date.now() - session.promptStartedAt),
      typedAnswer: session.typedAnswer,
      status: 'syncing',
    };
    setLastGrade(grade);
    setUndoError('');
    void onReview(currentItem.data.id, rating, {
      taskType,
      durationMs: grade.durationMs,
      sessionId: session.id,
      eventId,
    }).then(synced => {
      setLastGrade(current => current?.eventId === eventId
        ? { ...current, status: synced ? 'ready' : 'waiting' }
        : current);
    }).catch(() => {
      setLastGrade(current => current?.eventId === eventId ? { ...current, status: 'waiting' } : current);
    });
    setSession(current => current ? {
      ...current,
      index: current.index + 1,
      revealed: false,
      typedAnswer: '',
      promptStartedAt: Date.now(),
      ratings: { ...current.ratings, [rating]: current.ratings[rating] + 1 },
    } : null);
  };

  const undoLastGrade = async () => {
    const grade = lastGrade;
    if (!grade || !session || grade.sessionId !== session.id || grade.status === 'undoing') return;
    setLastGrade(current => current?.eventId === grade.eventId ? { ...current, status: 'undoing' } : current);
    setUndoError('');
    try {
      await onUndoReview(grade.eventId);
      setSession(current => current ? {
        ...current,
        index: grade.itemIndex,
        revealed: true,
        typedAnswer: grade.typedAnswer,
        promptStartedAt: Date.now(),
        ratings: {
          ...current.ratings,
          [grade.rating]: Math.max(0, current.ratings[grade.rating] - 1),
        },
      } : null);
      setLastGrade(null);
    } catch (error) {
      setLastGrade(current => current?.eventId === grade.eventId ? { ...current, status: 'waiting' } : current);
      setUndoError(error instanceof Error ? error.message : 'The review could not be undone.');
    }
  };

  const closeSession = () => {
    setLastGrade(null);
    setUndoError('');
    setSession(null);
  };

  useEffect(() => {
    if (!session || interactionLocked) return;
    const handleSessionKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSession();
        return;
      }
      if (isTyping) return;
      if (event.key.toLowerCase() === 'u' && lastGrade && lastGrade.status !== 'undoing') {
        event.preventDefault();
        void undoLastGrade();
        return;
      }
      if (!session.revealed && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        setSession(current => current ? { ...current, revealed: true } : null);
        return;
      }
      if (!session.revealed) return;
      const rating = keyboardRatings[event.key];
      if (rating) {
        event.preventDefault();
        gradeCurrent(rating);
      }
    };
    window.addEventListener('keydown', handleSessionKey);
    return () => window.removeEventListener('keydown', handleSessionKey);
  }, [session, currentItem, lastGrade, interactionLocked]);


  if (items.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-500 bg-slate-50">
        <div className="w-20 h-20 bg-slate-200 rounded-full flex items-center justify-center mb-4">
          <BrainCircuit size={40} className="text-slate-400" />
        </div>
        <h3 className="text-xl font-bold text-slate-700 mb-2">Your Study Space</h3>
        <p className="max-w-xs">Add vocabulary and phrases to your notebook to begin your learning journey with smart spaced repetition.</p>
      </div>
    );
  }

  if (session) {
    if (sessionComplete || !currentItem) {
      const remembered = session.ratings.hard + session.ratings.good + session.ratings.easy;
      return (
        <div className="h-full overflow-y-auto bg-slate-50 p-5 pb-24">
          <div className="max-w-xl mx-auto pt-10">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-bold text-slate-800">Session complete</h2>
              <button onClick={closeSession} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="Close session summary"><X size={20} /></button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 border-y border-slate-200 py-5 mb-6">
              {(['again', 'hard', 'good', 'easy'] as ReviewRating[]).map(rating => (
                <div key={rating} className="text-center">
                  <div className="text-2xl font-bold text-slate-800">{session.ratings[rating]}</div>
                  <div className="text-xs capitalize text-slate-500">{rating}</div>
                </div>
              ))}
            </div>
            <p className="text-sm text-slate-600 mb-6">Recalled {remembered} of {session.itemIds.length} prompts.</p>
            {lastGrade && (
              <button onClick={() => void undoLastGrade()} disabled={lastGrade.status === 'undoing'} className="mb-3 w-full h-12 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-100 disabled:opacity-60 inline-flex items-center justify-center gap-2" aria-keyshortcuts="U">
                <Undo2 size={18} /> {lastGrade.status === 'undoing' ? 'Undoing...' : 'Undo last rating'}
              </button>
            )}
            {undoError && <p className="mb-3 text-sm text-rose-700" role="alert">{undoError}</p>}
            <button onClick={closeSession} className="w-full h-12 bg-slate-900 text-white font-semibold rounded-lg hover:bg-slate-800">Return to study</button>
          </div>
        </div>
      );
    }

    const task = selectReviewTask(currentItem);
    const content = getStudyContent(currentItem);
    const example = stripStudyMarkers(content.example);
    const previews = SRSAlgorithm.previewRatings(currentItem.srs);
    const prompt = task === 'meaning'
      ? content.word
      : task === 'production'
        ? (content.chinese || content.definition)
        : task === 'cloze'
          ? createClozePrompt(content.example, content.word)
          : '';
    return (
      <div className="h-full overflow-y-auto bg-slate-50 p-4 pb-24">
        <div className="max-w-2xl mx-auto min-h-full flex flex-col">
          <header className="h-14 flex items-center justify-between border-b border-slate-200">
            <span className="text-sm font-semibold text-slate-600">{session.index + 1} / {session.itemIds.length}</span>
            <span className="text-xs font-medium uppercase text-slate-400">{task}</span>
            <div className="flex items-center gap-1">
              {lastGrade && (
                <button onClick={() => void undoLastGrade()} disabled={lastGrade.status === 'undoing'} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200 disabled:opacity-50" aria-label="Undo last rating" aria-keyshortcuts="U" title="Undo last rating">
                  <Undo2 size={19} />
                </button>
              )}
              <button onClick={closeSession} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="End study session"><X size={20} /></button>
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
                onChange={event => setSession(current => current ? { ...current, typedAnswer: event.target.value } : null)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setSession(current => current ? { ...current, revealed: true } : null);
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
                        onOpenExampleSentence(content.example, content.word, getItemSense(currentItem) || undefined);
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
                onClick={() => setSession(current => current ? { ...current, revealed: true } : null)}
                className="mt-12 mx-auto h-12 px-6 inline-flex items-center gap-2 bg-white border border-slate-300 rounded-lg font-semibold text-slate-700 hover:bg-slate-100"
                aria-keyshortcuts="Space Enter"
              >
                <Eye size={18} /> Reveal answer
              </button>
            )}
          </section>

          {session.revealed && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-slate-200 pt-4">
              {(['again', 'hard', 'good', 'easy'] as ReviewRating[]).map(rating => (
                <button
                  key={rating}
                  onClick={() => gradeCurrent(rating)}
                  aria-keyshortcuts={String((['again', 'hard', 'good', 'easy'] as ReviewRating[]).indexOf(rating) + 1)}
                  className={`h-14 rounded-lg border font-semibold capitalize ${rating === 'again' ? 'border-rose-300 text-rose-700 bg-rose-50' : rating === 'hard' ? 'border-amber-300 text-amber-700 bg-amber-50' : rating === 'good' ? 'border-emerald-300 text-emerald-700 bg-emerald-50' : 'border-blue-300 text-blue-700 bg-blue-50'}`}
                >
                  <span className="block">{rating}</span>
                  <span className="block text-[11px] font-normal opacity-75">{formatReviewInterval(previews[rating].interval)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return <StudyDashboard items={items} reviewHistory={reviewHistory} onStart={startSession} onScroll={onScroll} />;
};
