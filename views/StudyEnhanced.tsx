/**
 * The study tab: the progress dashboard between sessions (StudyDashboard) and the review session itself.
 *
 * Review sessions use the same item-level FSRS state and authoritative event stream as quick review. This
 * component holds the session, its keys and its audio; each step of the session (start, grade, undo, cards passed
 * over) is a pure function in services/studySession.ts, and components/study draws the card and the summary. The
 * session's record (services/studySessionRecord.ts) lets it survive a reload.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StoredItem, getItemTitle, type ItemGroup, type ReviewHistory, type ReviewRating } from '../types';
import { BrainCircuit } from 'lucide-react';
import {
  acceptFooterTap,
  applyUndoneGrade,
  endSessionEarly,
  findSessionCard,
  getStudyContent,
  gradeSessionCard,
  isSessionCardLive,
  listeningPrompt,
  moveSessionTo,
  openCardGroup,
  receiptText,
  resumeSession,
  sessionSiblingCounts,
  startStudySession,
  summarizeSession,
  undoFailureText,
  upcomingListeningPrompts,
  type SessionGrade,
  type SessionReview,
  type StudySession,
  type UndoFailure,
} from '../services/studySession';
import { updateAfterRating } from '../services/fsrsScheduler';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { resolveStudyKey } from '../services/studyKeys';
import { StudyDashboard } from '../components/StudyDashboard';
import { StudyCard } from '../components/study/StudyCard';
import { StudySummary } from '../components/study/StudySummary';
import { createSessionAudio, type SessionAudioEngine } from '../components/study/sessionAudio';
import { useEscapeLayer } from '../components/escapeStack';
import { isDialogOpenOutside, isKeyboardFocusedControl, isTypingTarget } from '../components/keyboardTarget';
import { useLatest } from '../hooks/useStableValue';
import { warn } from '../services/logger';
import { getPlaybackProgress, getPlaybackState, pauseCurrent, prefetchTTS, resumeCurrent, speakNatural, speakWord } from '../services/neuralTts';
import { readPendingReviewMutations } from '../services/reviewQueue';
import { decodeStudySession, encodeStudySession, recordChanged, restoreQueue, restoredSession } from '../services/studySessionRecord';
import { clearStoredStudySession, readStoredStudySession, writeStoredStudySession } from '../services/studySessionStore';

interface StudyEnhancedProps {
  /** The signed-in user, whose review outbox tells when a grade has reached the server, and whose session record a
   *  reload brings back. */
  userId: string;
  items: StoredItem[];
  /** The review history, and whether a load of it has succeeded yet (useReviewHistory). */
  reviewHistory: ReviewHistory & { loaded?: boolean };
  /** Records a review. `reviewedAt` is the grade's own time, which the review stamps as the card's lastReviewDate. */
  onReview: (itemId: string, rating: ReviewRating, context: SessionReview) => Promise<boolean>;
  /** Takes back a review on the server: false while it's still in the outbox, and a request that fails throws. */
  onUndoReview: (eventId: string) => Promise<boolean>;
  onOpenExampleSentence: (text: string, sourceWord: string, sourceSense?: string) => void;
  /** Opens the card view on `groups` (App's handleViewStoredItem): the words the summary lists to look at again open
   *  their cards through it. */
  onViewCards: (groups: ItemGroup[], groupIndex: number, itemIndex: number) => void;
  interactionLocked?: boolean;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

interface LastGrade extends SessionGrade {
  /** An undo of this grade is under way. */
  undoing: boolean;
  /** The grade is still in the review outbox, not yet on the server. */
  waiting: boolean;
}

/** The speech engine a session's audio goes through. */
const SESSION_AUDIO_ENGINE: SessionAudioEngine = {
  speakNatural, speakWord, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, prefetchTTS,
};

/** How long a failed undo is said in the receipt line before the receipt comes back. */
const UNDO_ERROR_MS = 4_000;
/** How often the receipt looks for a waiting grade to have left the review outbox. */
const OUTBOX_RECHECK_MS = 3_000;

/** Whether a review is still in the user's outbox, not yet on the server. */
const isQueuedReview = (userId: string, eventId: string): boolean =>
  readPendingReviewMutations(userId).some(mutation => mutation.event.id === eventId);

const revealAnswer = (current: StudySession | null): StudySession | null => current ? { ...current, revealed: true } : null;

/**
 * The session this user had going on this device before a reload, from its record: at the card it was on, unrevealed,
 * when the record is theirs, under six hours old and has a card left. A record that can't be taken up is cleared.
 */
function restoreSession(userId: string, items: readonly StoredItem[], now: number): StudySession | null {
  if (items.length === 0) return null;
  const raw = readStoredStudySession();
  if (raw === null) return null;
  const record = decodeStudySession(raw, userId, now);
  const itemsById = new Map(items.map(item => [item.data.id, item]));
  const index = record && restoreQueue(record, id => itemsById.has(id), id => itemsById.get(id)?.srs?.lastReviewDate ?? 0);
  if (!record || index === null) {
    clearStoredStudySession();
    return null;
  }
  const queue = record.itemIds.flatMap(id => itemsById.get(id) ?? []);
  return restoredSession(record, index, now, sessionSiblingCounts(queue, items));
}

export const StudyEnhanced: React.FC<StudyEnhancedProps> = ({ 
  userId,
  items, 
  reviewHistory,
  onReview,
  onUndoReview,
  onOpenExampleSentence,
  onViewCards,
  interactionLocked = false,
  onScroll,
}) => {
  const [session, setSession] = useState<StudySession | null>(() => restoreSession(userId, items, Date.now()));
  // A restored session's last grade may still be in the outbox, so it comes back without its undo.
  const [lastGrade, setLastGrade] = useState<LastGrade | null>(null);
  const [undoError, setUndoError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // A card deleted or archived mid-session, or reviewed elsewhere since it began (or since the session last graded
  // it), is passed over instead of ending the session there.
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

  // The session's record, written when it starts, grades, undoes or moves to another card, never as an answer is typed
  // or shown. The newest write wins across tabs. A restored session is already written.
  const recordedRef = useRef(session);
  useEffect(() => {
    if (!session || !recordChanged(recordedRef.current, session)) return;
    recordedRef.current = session;
    writeStoredStudySession(encodeStudySession(session, userId, Date.now()));
  }, [session, userId]);

  // The session's own audio (components/study/sessionAudio.ts). A grade, an end or an undo stops what it started, and
  // so does leaving the tab; audio it didn't start plays on.
  const [audio] = useState(() => createSessionAudio(SESSION_AUDIO_ENGINE));
  // The listening prompt played last, by session and position, so each showing of a card plays its prompt once.
  const playedPromptRef = useRef<string | null>(null);
  // Leaving the tab stops the session's audio; coming back plays the card's listening prompt again.
  useEffect(() => () => {
    audio.stopAll();
    playedPromptRef.current = null;
  }, [audio]);

  const startSession = useCallback((queue: StoredItem[]) => {
    if (queue.length === 0) return;
    setLastGrade(null);
    setUndoError('');
    const started = startStudySession(crypto.randomUUID(), queue, Date.now(), sessionSiblingCounts(queue, items));
    setSession(started);
    // A first card that is a listening prompt plays inside the Start press, where iOS lets a page start its first sound.
    const firstPrompt = listeningPrompt(queue[0]);
    if (firstPrompt !== null) {
      playedPromptRef.current = `${started.id}:0`;
      audio.playPrompt(firstPrompt);
    }
  }, [items, audio]);

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
    // The answer says its word as it shows, unless a sentence (the listening prompt) is still being read.
    if (session && currentItem && !session.revealed) audio.sayWordOnReveal(getStudyContent(currentItem).word);
    setSession(revealAnswer);
  };

  const gradeCurrent = (rating: ReviewRating) => {
    if (!session || !currentItem || !session.revealed || undoing) return;
    audio.stopAll();
    lastActionAtRef.current = performance.now();
    const eventId = crypto.randomUUID();
    const now = Date.now();
    // The interval the grade sets, scheduled as updateSRS will schedule it.
    const intervalMinutes = updateAfterRating(
      SRSAlgorithm.ensure(currentItem.srs, currentItem.data.id, currentItem.type), rating, now,
    ).interval;
    // The review and the step that moves the session on come from one call with one time, so the review is stamped
    // with the time the session keeps with the grade (gradeSessionCard).
    const { grade: sessionGrade, review, advance } = gradeSessionCard(session, currentItem, rating, eventId, now, intervalMinutes);
    const grade: LastGrade = { ...sessionGrade, undoing: false, waiting: false };
    setLastGrade(grade);
    setUndoError('');
    void onReview(currentItem.data.id, rating, review).then(synced => {
      // Not on the server yet: the receipt says it's saved on this device until the outbox sends it.
      if (synced || !isQueuedReview(userId, eventId)) return;
      setLastGrade(current => current?.eventId === eventId ? { ...current, waiting: true } : current);
    }).catch(error => warn('Review failed:', error));
    setSession(current => current && advance(current));
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
    audio.stopAll();
    setLastGrade(current => current?.eventId === grade.eventId ? { ...current, undoing: true } : current);
    setUndoError('');
    let failure: UndoFailure;
    try {
      if (await onUndoReview(grade.eventId)) {
        // The session may have ended, or another started, while the undo was on its way.
        setSession(current => applyUndoneGrade(current, grade, Date.now()));
        setLastGrade(current => current?.eventId === grade.eventId ? null : current);
        return;
      }
      failure = 'waiting';
    } catch (error) {
      failure = { error };
    }
    setLastGrade(current => current?.eventId === grade.eventId ? { ...current, undoing: false } : current);
    if (sessionIdRef.current === grade.sessionId) setUndoError(undoFailureText(failure, navigator.onLine));
  };

  // The summary shows once no card is left, or once the session was ended early; a session ended early with a card
  // left can be resumed there.
  const showingSummary = !!session && (!currentItem || !!session.ended);
  const canResume = !!session?.ended && !!currentItem;

  // On a card the failed undo takes the receipt line's place for a few seconds; the summary keeps its own line.
  const showingCard = !!session && !showingSummary;
  useEffect(() => {
    if (!undoError || !showingCard) return;
    const timer = window.setTimeout(() => setUndoError(''), UNDO_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [undoError, showingCard]);

  // Done, Esc on a summary, or ending before the first grade: the session is over, and a reload doesn't bring it back.
  // A session ended early keeps its record, so a reload takes it up at its card.
  const closeSession = () => {
    audio.stopAll();
    setLastGrade(null);
    setUndoError('');
    setSession(null);
    clearStoredStudySession();
  };

  // Ending a session after a grade shows its summary, 'Ended early', where Resume takes it up again; with no grade
  // yet there is nothing to sum up, so it closes.
  const endSession = () => {
    audio.stopAll();
    if (session && session.grades.length > 0) setSession(current => current && endSessionEarly(current));
    else closeSession();
  };
  // Open card: the card view over the session, on this card among its senses, so ← and → reach the others. Closing it
  // comes back to the same card, revealed; a Got it given there counts, and the session moves past the card, as it
  // does past any card reviewed elsewhere.
  const openCard = () => {
    if (!currentItem) return;
    const { group, index } = openCardGroup(currentItem, items);
    onViewCards([group], 0, index);
  };

  // Taken up again, the card plays its listening prompt again.
  const resume = () => {
    playedPromptRef.current = null;
    setSession(current => current && resumeSession(current, Date.now()));
  };

  // A listening card plays its prompt as it shows, unrevealed and with nothing over it, without the Kokoro download a
  // miss would start: the first card inside the Start press (startSession), each later one here, once per showing. A
  // session restored at launch tries once; iOS may wait for a tap, and the prompt's button always plays it.
  const shownPrompt = showingCard && !interactionLocked && currentItem && !session.revealed ? listeningPrompt(currentItem) : null;
  const shownPromptKey = shownPrompt !== null && session ? `${session.id}:${currentIndex}` : null;
  useEffect(() => {
    if (shownPromptKey === null || shownPrompt === null || playedPromptRef.current === shownPromptKey) return;
    playedPromptRef.current = shownPromptKey;
    audio.playPrompt(shownPrompt);
  }, [shownPromptKey, shownPrompt, audio]);

  // The clips of the next listening prompts are fetched as each card shows (never generated), so they start at once.
  const cardKey = session ? `${session.id}:${currentIndex}` : null;
  const upcomingRef = useLatest({ session, currentIndex, itemsById });
  useEffect(() => {
    const upcoming = upcomingRef.current;
    if (cardKey === null || !upcoming.session) return;
    audio.prefetch(upcomingListeningPrompts(upcoming.session, upcoming.currentIndex, id => upcoming.itemsById.get(id)));
  }, [cardKey, audio, upcomingRef]);

  // Escape leaves the answer box first, then ends the session on a card or closes the summary. It goes through the
  // escape stack, so a search box or dialog opened over the session closes before the session does.
  useEscapeLayer(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && isTypingTarget(active) && rootRef.current?.contains(active)) active.blur();
    else if (showingCard) endSession();
    else closeSession();
  }, 0, !!session && !interactionLocked);

  // The session's keys (services/studyKeys.ts). One listener while the session has the keys, reading the
  // session and the handlers as they are now, so typing an answer doesn't register it again.
  const keyContext = useLatest({ session, currentItem, showingSummary, canResume, lastGrade, reveal, gradeCurrent, undoLastGrade, closeSession, resume });
  const keysActive = !!session && !interactionLocked;
  useEffect(() => {
    if (!keysActive) return;
    // In the capture phase the session gets its keys before the window-level shortcuts (1-3 also switch
    // tabs), and stops the ones it uses so no other shortcut reacts to them.
    const handleSessionKey = (event: KeyboardEvent) => {
      const { session, currentItem, showingSummary, canResume, lastGrade, reveal, gradeCurrent, undoLastGrade, closeSession, resume } = keyContext.current;
      if (!session) return;
      const content = currentItem ? getStudyContent(currentItem) : null;
      const cardPrompt = currentItem ? listeningPrompt(currentItem) : null;
      const action = resolveStudyKey(event, {
        phase: showingSummary ? 'summary' : 'card',
        revealed: session.revealed,
        listening: cardPrompt !== null,
        hasExample: !!content?.example,
        canUndo: !!lastGrade,
        undoing: lastGrade?.undoing ?? false,
        canResume,
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
      else if (action.type === 'done') closeSession();
      else if (action.type === 'resume') resume();
      else if (action.type === 'speakWord' && content) audio.sayWord(content.word);
      else if (action.type === 'replayPrompt' && cardPrompt !== null) audio.replayPrompt(cardPrompt);
      else if (action.type === 'toggleExample' && content) audio.toggleSentence(content.example);
    };
    window.addEventListener('keydown', handleSessionKey, true);
    return () => window.removeEventListener('keydown', handleSessionKey, true);
  }, [keysActive, keyContext, audio]);

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
    if (showingSummary || !currentItem) {
      const summary = summarizeSession(session);
      // The words to look at again (rated Again or Hard) still in the library; each opens the card view with them all
      // as its list.
      const missedItems = summary.missedIds.flatMap(id => itemsById.get(id) ?? []);
      const openMissed = (index: number) => onViewCards(
        missedItems.map(item => ({ title: getItemTitle(item), items: [item] })), index, 0,
      );
      return (
        <div ref={rootRef} className="h-full overflow-y-auto bg-slate-50 p-5 pb-[calc(var(--nav-h,95px)+1rem)]">
          <StudySummary
            summary={summary}
            endedEarly={!!session.ended}
            onResume={canResume ? resume : undefined}
            missed={missedItems.map(item => ({ id: item.data.id, title: getItemTitle(item) }))}
            onOpenMissed={openMissed}
            canUndo={!!lastGrade}
            undoing={undoing}
            undoError={undoError}
            onUndo={undo}
            onDone={closeSession}
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
          onClose={endSession}
          onReveal={reveal}
          onFooterReveal={footerReveal}
          onFooterGrade={footerGrade}
          onTypeAnswer={typedAnswer => setSession(current => current ? { ...current, typedAnswer } : null)}
          onOpenExampleSentence={onOpenExampleSentence}
          onOpenCard={openCard}
        />
      </div>
    );
  }

  return (
    <StudyDashboard
      items={items}
      reviewHistory={reviewHistory}
      onStart={startSession}
      interactionLocked={interactionLocked}
      onScroll={onScroll}
    />
  );
};
