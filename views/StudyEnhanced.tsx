/**
 * The study tab: the progress dashboard between sessions (StudyDashboard) and the review session itself.
 *
 * Review sessions use the same item-level FSRS state and authoritative event stream as quick review. This
 * component holds the session and its keys; each step of the session (start, grade, undo, cards passed over)
 * is a pure function in services/studySession.ts, and components/study draws the card and the summary.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StoredItem, type ReviewHistory, type ReviewRating, type ReviewTaskType } from '../types';
import { BrainCircuit } from 'lucide-react';
import {
  RATINGS,
  advanceSession,
  findSessionCard,
  gradeSessionCard,
  moveSessionTo,
  startStudySession,
  undoSessionGrade,
  type SessionGrade,
  type StudySession,
} from '../services/studySession';
import { StudyDashboard } from '../components/StudyDashboard';
import { StudyCard } from '../components/study/StudyCard';
import { StudySummary } from '../components/study/StudySummary';
import { useEscapeLayer } from '../components/escapeStack';
import { isDialogOpenOutside, isKeyboardFocusedControl, isTypingTarget } from '../components/keyboardTarget';
import { warn } from '../services/logger';

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

interface LastGrade extends SessionGrade {
  /** An undo of this grade is under way. */
  undoing: boolean;
}

const keyboardRatings: Partial<Record<string, ReviewRating>> = Object.fromEntries(
  RATINGS.map((rating, i) => [String(i + 1), rating]),
);

const revealAnswer = (current: StudySession | null): StudySession | null => current ? { ...current, revealed: true } : null;

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
  const rootRef = useRef<HTMLDivElement>(null);

  // A card deleted or archived mid-session is passed over instead of ending the session there.
  const itemsById = useMemo(() => new Map(items.map(item => [item.data.id, item])), [items]);
  const currentIndex = session
    ? findSessionCard(session.itemIds, session.index, session.passedOverFrom, id => itemsById.has(id))
    : 0;
  const currentId = session?.itemIds[currentIndex];
  const currentItem: StoredItem | null = (currentId !== undefined && itemsById.get(currentId)) || null;

  // Move the session past the cards passed over, or back to one that returned, so the card shown starts
  // unrevealed and unanswered.
  useLayoutEffect(() => {
    if (!session || currentIndex === session.index) return;
    setSession(current => current ? moveSessionTo(current, currentIndex, Date.now()) : null);
  }, [session, currentIndex]);

  const startSession = useCallback((queue: StoredItem[]) => {
    if (queue.length === 0) return;
    setLastGrade(null);
    setUndoError('');
    setSession(startStudySession(crypto.randomUUID(), queue, Date.now()));
  }, []);

  const gradeCurrent = (rating: ReviewRating) => {
    if (!session || !currentItem || !session.revealed) return;
    const eventId = crypto.randomUUID();
    const { grade: sessionGrade, itemIds } = gradeSessionCard(session, currentItem, rating, eventId, Date.now());
    const grade: LastGrade = { ...sessionGrade, undoing: false };
    setLastGrade(grade);
    setUndoError('');
    void onReview(currentItem.data.id, rating, {
      taskType: grade.taskType,
      durationMs: grade.durationMs,
      sessionId: session.id,
      eventId,
    }).catch(error => warn('Review failed:', error));
    setSession(current => current ? advanceSession(current, itemIds, rating, Date.now()) : null);
  };

  const undoLastGrade = async () => {
    const grade = lastGrade;
    if (!grade || !session || grade.sessionId !== session.id || grade.undoing) return;
    setLastGrade(current => current?.eventId === grade.eventId ? { ...current, undoing: true } : current);
    setUndoError('');
    try {
      await onUndoReview(grade.eventId);
      setSession(current => current ? undoSessionGrade(current, grade, Date.now()) : null);
      setLastGrade(null);
    } catch (error) {
      setLastGrade(current => current?.eventId === grade.eventId ? { ...current, undoing: false } : current);
      setUndoError(error instanceof Error ? error.message : 'The review could not be undone.');
    }
  };

  const closeSession = () => {
    setLastGrade(null);
    setUndoError('');
    setSession(null);
  };

  // Escape leaves the answer box first, then ends the session. It goes through the escape stack, so a
  // search box or dialog opened over the session closes before the session does.
  useEscapeLayer(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && isTypingTarget(active) && rootRef.current?.contains(active)) active.blur();
    else closeSession();
  }, 0, !!session && !interactionLocked);

  useEffect(() => {
    if (!session || interactionLocked) return;
    // In the capture phase the session gets its keys before the window-level shortcuts (1-3 also switch
    // tabs), and stops the ones it uses so no other shortcut reacts to them.
    const handleSessionKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || isDialogOpenOutside(rootRef.current)) return;
      const rating = keyboardRatings[event.key];
      if (rating) {
        // The session owns 1-4 even before the answer shows: an early press does nothing rather than
        // switch tabs mid-session.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (session.revealed) gradeCurrent(rating);
        return;
      }
      if (event.key.toLowerCase() === 'u' && lastGrade && !lastGrade.undoing) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void undoLastGrade();
        return;
      }
      // Space and Enter reveal the answer, unless the keyboard has focused a button they should press.
      if ((event.key === ' ' || event.key === 'Enter') && currentItem && !session.revealed && !isKeyboardFocusedControl(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSession(revealAnswer);
      }
    };
    window.addEventListener('keydown', handleSessionKey, true);
    return () => window.removeEventListener('keydown', handleSessionKey, true);
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
    const undo = () => void undoLastGrade();
    const undoing = lastGrade?.undoing ?? false;
    if (!currentItem) {
      return (
        <div ref={rootRef} className="h-full overflow-y-auto bg-slate-50 p-5 pb-24">
          <StudySummary
            ratings={session.ratings}
            canUndo={!!lastGrade}
            undoing={undoing}
            undoError={undoError}
            onUndo={undo}
            onClose={closeSession}
          />
        </div>
      );
    }

    return (
      <div ref={rootRef} className="h-full overflow-y-auto bg-slate-50 p-4 pb-24">
        <StudyCard
          session={session}
          item={currentItem}
          canUndo={!!lastGrade}
          undoing={undoing}
          undoError={undoError}
          onUndo={undo}
          onClose={closeSession}
          onReveal={() => setSession(revealAnswer)}
          onTypeAnswer={typedAnswer => setSession(current => current ? { ...current, typedAnswer } : null)}
          onGrade={gradeCurrent}
          onOpenExampleSentence={onOpenExampleSentence}
        />
      </div>
    );
  }

  return <StudyDashboard items={items} reviewHistory={reviewHistory} onStart={startSession} onScroll={onScroll} />;
};
