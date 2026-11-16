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
  acceptFooterTap,
  advanceSession,
  applyUndoneGrade,
  findSessionCard,
  gradeSessionCard,
  isSessionCardLive,
  moveSessionTo,
  receiptText,
  sessionRatings,
  sessionSiblingCounts,
  startStudySession,
  type SessionGrade,
  type StudySession,
} from '../services/studySession';
import { updateAfterRating } from '../services/fsrsScheduler';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { resolveStudyKey } from '../services/studyKeys';
import { StudyDashboard } from '../components/StudyDashboard';
import { StudyCard } from '../components/study/StudyCard';
import { StudySummary } from '../components/study/StudySummary';
import { useEscapeLayer } from '../components/escapeStack';
import { isDialogOpenOutside, isKeyboardFocusedControl, isTypingTarget } from '../components/keyboardTarget';
import { useLatest } from '../hooks/useStableValue';
import { warn } from '../services/logger';
import { readPendingReviewMutations } from '../services/reviewQueue';

interface StudyEnhancedProps {
  /** The signed-in user, whose review outbox tells when a grade has reached the server. Optional until App passes
   *  it; without it the receipt never says a grade is waiting. */
  userId?: string;
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
  /** The grade is still in the review outbox, not yet on the server. */
  waiting: boolean;
}

/** How long a failed undo is said in the receipt line before the receipt comes back. */
const UNDO_ERROR_MS = 4_000;
/** How often the receipt looks for a waiting grade to have left the review outbox. */
const OUTBOX_RECHECK_MS = 3_000;

/** Whether a review is still in the user's outbox, not yet on the server. Without a user it can't tell, so it says no. */
const isQueuedReview = (userId: string | undefined, eventId: string): boolean =>
  !!userId && readPendingReviewMutations(userId).some(mutation => mutation.event.id === eventId);

const revealAnswer = (current: StudySession | null): StudySession | null => current ? { ...current, revealed: true } : null;

export const StudyEnhanced: React.FC<StudyEnhancedProps> = ({ 
  userId,
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

  // A card deleted or archived mid-session, or reviewed elsewhere since it began, is passed over instead of
  // ending the session there.
  const itemsById = useMemo(() => new Map(items.map(item => [item.data.id, item])), [items]);
  const currentIndex = session
    ? findSessionCard(session.itemIds, session.index, session.passedOverFrom, id => isSessionCardLive(itemsById.get(id), session))
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
    setSession(startStudySession(crypto.randomUUID(), queue, Date.now(), sessionSiblingCounts(queue, items)));
  }, [items]);

  // While the last grade waits in the outbox, look every few seconds for it to have reached the server.
  const waitingEventId = lastGrade?.waiting ? lastGrade.eventId : undefined;
  useEffect(() => {
    if (!waitingEventId) return;
    const timer = window.setInterval(() => {
      if (isQueuedReview(userId, waitingEventId)) return;
      setLastGrade(current => current?.eventId === waitingEventId ? { ...current, waiting: false } : current);
    }, OUTBOX_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [waitingEventId, userId]);

  // While an undo is under way, grading and revealing wait: the undo is about to bring back the card it undoes.
  const undoing = lastGrade?.undoing ?? false;
  const sessionIdRef = useLatest(session?.id);
  // When the last reveal or grade happened, made any way, on a clock that never goes back: a footer tap just
  // after it is the second tap of a double tap (acceptFooterTap).
  const lastActionAtRef = useRef<number | undefined>(undefined);

  const reveal = () => {
    if (undoing) return;
    lastActionAtRef.current = performance.now();
    setSession(revealAnswer);
  };

  const gradeCurrent = (rating: ReviewRating) => {
    if (!session || !currentItem || !session.revealed || undoing) return;
    lastActionAtRef.current = performance.now();
    const eventId = crypto.randomUUID();
    const now = Date.now();
    // The interval the grade sets, scheduled as updateSRS will schedule it.
    const intervalMinutes = updateAfterRating(
      SRSAlgorithm.ensure(currentItem.srs, currentItem.data.id, currentItem.type), rating, now,
    ).interval;
    const { grade: sessionGrade, itemIds } = gradeSessionCard(session, currentItem, rating, eventId, now, intervalMinutes);
    const grade: LastGrade = { ...sessionGrade, undoing: false, waiting: false };
    setLastGrade(grade);
    setUndoError('');
    void onReview(currentItem.data.id, rating, {
      taskType: grade.taskType,
      durationMs: grade.durationMs,
      sessionId: session.id,
      eventId,
    }).then(synced => {
      // Not on the server yet: the receipt says it's saved on this device until the outbox sends it.
      if (synced || !isQueuedReview(userId, eventId)) return;
      setLastGrade(current => current?.eventId === eventId ? { ...current, waiting: true } : current);
    }).catch(error => warn('Review failed:', error));
    setSession(current => current ? advanceSession(current, itemIds, grade, now) : null);
  };

  // The footer's Show answer and grades ignore a tap that is the second of a double tap; keys act at once.
  const footerTapCounts = () => acceptFooterTap(lastActionAtRef.current, performance.now());
  const footerReveal = () => {
    if (footerTapCounts()) reveal();
  };
  const footerGrade = (rating: ReviewRating) => {
    if (footerTapCounts()) gradeCurrent(rating);
  };

  const undoLastGrade = async () => {
    const grade = lastGrade;
    if (!grade || !session || grade.sessionId !== session.id || grade.undoing) return;
    setLastGrade(current => current?.eventId === grade.eventId ? { ...current, undoing: true } : current);
    setUndoError('');
    try {
      await onUndoReview(grade.eventId);
      // The session may have ended, or another started, while the undo was on its way.
      setSession(current => applyUndoneGrade(current, grade, Date.now()));
      setLastGrade(current => current?.eventId === grade.eventId ? null : current);
    } catch (error) {
      setLastGrade(current => current?.eventId === grade.eventId ? { ...current, undoing: false } : current);
      if (sessionIdRef.current === grade.sessionId) {
        setUndoError(error instanceof Error ? error.message : 'The review could not be undone.');
      }
    }
  };

  // On a card the failed undo takes the receipt line's place for a few seconds; the summary keeps its own line.
  const showingCard = !!session && !!currentItem;
  useEffect(() => {
    if (!undoError || !showingCard) return;
    const timer = window.setTimeout(() => setUndoError(''), UNDO_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [undoError, showingCard]);

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

  // The session's keys (services/studyKeys.ts). One listener while the session has the keys, reading the
  // session and the handlers as they are now, so typing an answer doesn't register it again.
  const keyContext = useLatest({ session, currentItem, lastGrade, reveal, gradeCurrent, undoLastGrade });
  const keysActive = !!session && !interactionLocked;
  useEffect(() => {
    if (!keysActive) return;
    // In the capture phase the session gets its keys before the window-level shortcuts (1-3 also switch
    // tabs), and stops the ones it uses so no other shortcut reacts to them.
    const handleSessionKey = (event: KeyboardEvent) => {
      const { session, currentItem, lastGrade, reveal, gradeCurrent, undoLastGrade } = keyContext.current;
      if (!session) return;
      const action = resolveStudyKey(event, {
        phase: currentItem ? 'card' : 'summary',
        revealed: session.revealed,
        canUndo: !!lastGrade,
        undoing: lastGrade?.undoing ?? false,
        typing: isTypingTarget(event.target),
        onControl: isKeyboardFocusedControl(event.target),
        dialogOutside: isDialogOpenOutside(rootRef.current),
      });
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action.type === 'grade') gradeCurrent(action.rating);
      else if (action.type === 'undo') void undoLastGrade();
      else if (action.type === 'reveal') reveal();
    };
    window.addEventListener('keydown', handleSessionKey, true);
    return () => window.removeEventListener('keydown', handleSessionKey, true);
  }, [keysActive, keyContext]);

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
    if (!currentItem) {
      return (
        <div ref={rootRef} className="h-full overflow-y-auto bg-slate-50 p-5 pb-[calc(var(--nav-h,95px)+1rem)]">
          <StudySummary
            ratings={sessionRatings(session)}
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
      <div ref={rootRef} className="h-full flex flex-col bg-slate-50">
        <StudyCard
          session={session}
          item={currentItem}
          canUndo={!!lastGrade}
          undoing={undoing}
          receipt={lastGrade && receiptText({ ...lastGrade, requeued: lastGrade.requeuedAt !== undefined })}
          undoError={undoError}
          onUndo={undo}
          onClose={closeSession}
          onReveal={reveal}
          onFooterReveal={footerReveal}
          onFooterGrade={footerGrade}
          onTypeAnswer={typedAnswer => setSession(current => current ? { ...current, typedAnswer } : null)}
          onOpenExampleSentence={onOpenExampleSentence}
        />
      </div>
    );
  }

  return <StudyDashboard items={items} reviewHistory={reviewHistory} onStart={startSession} onScroll={onScroll} />;
};
