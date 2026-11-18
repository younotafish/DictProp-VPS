/**
 * Today, the Study tab (DESIGN-v2 §8): a host that shows exactly one mode — the plan, a set or practice session, the
 * themes browser, or classic Study as Card review.
 *
 * Every step of a session (start, settle, reveal, hint, choose, answer, Next, undo) is a pure function in
 * services/learningLoop/session.ts; this component holds the session, records the reviews those steps return through
 * App's updateSRS and undoSRSReview, writes the session's record as it changes, and plays its audio. The plan is a
 * snapshot (services/learningLoop/planner.ts) taken as Today opens or shows again, after a session, when the theme map
 * changes and when the practice count changes with the clock, and never while you look at it otherwise, so it holds
 * still.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isVocabItem, type ItemGroup, type ReviewHistory, type ReviewRating, type StoredItem } from '../../types';
import { loadSetDays, loadThemes } from '../../services/api/learningLoop';
import { loopCard, sourceFormsLookup, type LoopMode } from '../../services/learningLoop/cues';
import { planLoop, type PlannedSet } from '../../services/learningLoop/planner';
import {
  answerAttempt,
  applyMeetBack,
  applyUndoneAttempt,
  attemptStage,
  chooseInMeet,
  currentItemId,
  finishEncoding,
  finishLook,
  isSessionOver,
  meetBackTarget,
  meetChoiceOpen,
  MODE_TASK_TYPES,
  practiceQueue,
  revealAnswer,
  runOf,
  sessionProgress,
  settleSession,
  startPracticeSession,
  startSetSession,
  summarizePractice,
  summarizeSet,
  takeHint,
  type AttemptUndo,
  type LoopReview,
  type LoopSession,
  type MeetChoice,
} from '../../services/learningLoop/session';
import {
  clearLoopSession,
  readLoopMode,
  readLoopSession,
  readSetStarts,
  readTodayPin,
  recordSetStart,
  writeLoopMode,
  writeLoopSession,
  writeTodayPin,
} from '../../services/learningLoop/sessionStore';
import { graduationDots, localDayKey } from '../../services/learningLoop/standing';
import { loopProgress, loopStreak, nextPracticeClockChange, setDaysLoader, sortedThisWeek, todaySetCount } from '../../services/learningLoop/stats';
import { createThemeSync, sortingPercent, type ThemeSorting, type ThemeState } from '../../services/learningLoop/themeMap';
import { previewRatings, updateAfterRating } from '../../services/fsrsScheduler';
import { warn } from '../../services/logger';
import { getPlaybackProgress, getPlaybackState, pauseCurrent, prefetchTTS, resumeCurrent, speakNatural, speakWord } from '../../services/neuralTts';
import { isMacPlatform } from '../../services/platform';
import { readPendingReviewMutations } from '../../services/reviewQueue';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import { countDueSpellings } from '../../services/studyStats';
import { acceptFooterTap, openCardGroup, undoFailureText, type SessionReview, type UndoFailure } from '../../services/studySession';
import { decodeStudySession, restoreQueue } from '../../services/studySessionRecord';
import { readStoredStudySession } from '../../services/studySessionStore';
import { getTtsStyle, setTtsStyle } from '../../services/ttsSettings';
import { useEscapeLayer } from '../../components/escapeStack';
import { isDialogOpenOutside, isKeyboardFocusedControl, isTypingTarget } from '../../components/keyboardTarget';
import { useNow } from '../../hooks/useNow';
import { useLatest } from '../../hooks/useStableValue';
import { StudyEnhanced } from '../StudyEnhanced';
import { createLoopAudio, type LoopAudioEngine } from './loopAudio';
import { LoopPlayer } from './LoopPlayer';
import { LoopSummary } from './LoopSummary';
import { ThemesBrowser } from './ThemesBrowser';
import { TodayPlan } from './TodayPlan';
import { resolveTodayKey, type TodayKeyAction, type TodayKeyState } from './todayKeys';
import {
  answerSpeech,
  attemptLabel,
  cardFooter,
  itemText,
  meetReceipt,
  pickRestore,
  planCardModel,
  practiceReturn,
  recordNeedsWrite,
  resumeLabel,
  runCaptions,
  runReceipt,
  sessionHasProgress,
  summaryActions,
  summaryHeadline,
  themeLabel,
  themesBrowserModel,
  todayHandlers,
  todayMode,
  upcomingSentences,
  withLoopMode,
  type LoopReceipt,
  type SummaryAction,
  type ThemesStatus,
  type TodayScreen,
} from './todayModel';

export interface TodayViewProps {
  /** The signed-in user, whose session record, pin and set starts this device keeps, and whose outbox tells when a
   *  review has reached the server. */
  userId: string;
  /** The whole library: Today plans from its words and the learner's own sentences. */
  items: StoredItem[];
  /** Classic Study's cards (useLibraryViews' studyItems), for Card review. */
  studyItems: StoredItem[];
  /** The review history, and whether a load of it has succeeded yet (useReviewHistory). */
  reviewHistory: ReviewHistory & { loaded?: boolean };
  /** Records a review (App's updateSRS). */
  onReview: (itemId: string, rating: ReviewRating, context: SessionReview) => Promise<boolean>;
  /** Takes back a review on the server: false while it's still in the outbox, and a request that fails throws. */
  onUndoReview: (eventId: string) => Promise<boolean>;
  onOpenExampleSentence: (text: string, sourceWord: string, sourceSense?: string) => void;
  /** Opens the card view on `groups` (App's handleViewStoredItem): ↗ on a word, and Card review's cards. */
  onViewCards: (groups: ItemGroup[], groupIndex: number, itemIndex: number) => void;
  /** Opens saved sentences in their lesson (App's handleViewSentence): ↗ on a sentence. */
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
  onLazyLoadImage: (itemId: string, imageVersion?: string) => Promise<string | null>;
  /** The app's undo pill is up, so ⌘Z takes back what it offers rather than the session's last review. */
  undoOffered: boolean;
  /** Something covers the tab (the card view), which has the keys. */
  interactionLocked?: boolean;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

/** The review the receipt line describes: the session's last, and, for a run's answer, what undoing it takes. */
interface LastReview {
  sessionId: string;
  eventId: string;
  receipt: LoopReceipt;
  /** A run's answer; a Meet choice is taken back through meetBackTarget, which also reaches the ones before it. */
  undo?: AttemptUndo;
  /** Still in the review outbox, not yet on the server. */
  waiting: boolean;
}

/** The speech engine Today's audio goes through. */
const LOOP_AUDIO_ENGINE: LoopAudioEngine = {
  speakNatural, speakWord, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, prefetchTTS, getTtsStyle, setTtsStyle,
};

/** How long a failed undo is said in the receipt line before the receipt comes back. */
const UNDO_ERROR_MS = 4_000;
/** How often the receipt looks for a waiting review to have left the review outbox. */
const OUTBOX_RECHECK_MS = 3_000;

const NO_THEMES: ReadonlyMap<string, string> = new Map();
const NO_ITEMS: ReadonlyMap<string, StoredItem> = new Map();

/** Card review keeps the memo App gave classic Study when it was the tab. */
const CardReview = React.memo(StudyEnhanced);

/** Whether a review is still in the user's outbox, not yet on the server. */
const isQueuedReview = (userId: string, eventId: string): boolean =>
  readPendingReviewMutations(userId).some(mutation => mutation.event.id === eventId);

/**
 * When classic Study's kept session was saved, if Card review would take it up (StudyEnhanced's restoreSession): the
 * user's, recent, and with a card left among `studyItems` that wasn't reviewed since. Null otherwise.
 */
function classicSavedAt(userId: string, studyItems: readonly StoredItem[], now: number): number | null {
  const raw = readStoredStudySession();
  const record = raw === null || studyItems.length === 0 ? null : decodeStudySession(raw, userId, now);
  if (!record) return null;
  const byId = new Map(studyItems.map(item => [item.data.id, item]));
  const left = restoreQueue(record, id => byId.has(id), id => byId.get(id)?.srs?.lastReviewDate ?? 0);
  return left === null ? null : record.savedAt;
}

/**
 * What Today opens on: the session this device kept for the user, or classic Study's, whichever is newer; the plan
 * offers the other with Resume.
 */
function restoreToday(userId: string, studyItems: readonly StoredItem[], now: number): { session: LoopSession | null; screen: TodayScreen } {
  const loop = readLoopSession(userId, now);
  const winner = pickRestore(loop?.savedAt ?? null, classicSavedAt(userId, studyItems, now));
  return { session: loop?.session ?? null, screen: winner === 'loop' ? 'session' : winner === 'classic' ? 'classic' : 'plan' };
}

export function TodayView({
  userId,
  items,
  studyItems,
  reviewHistory,
  onReview,
  onUndoReview,
  onOpenExampleSentence,
  onViewCards,
  onOpenSentence,
  onLazyLoadImage,
  undoOffered,
  interactionLocked = false,
  onScroll,
}: TodayViewProps) {
  const [initial] = useState(() => restoreToday(userId, studyItems, Date.now()));
  const [screen, setScreen] = useState<TodayScreen>(initial.screen);
  const [session, setSession] = useState<LoopSession | null>(initial.session);
  const [mode, setMode] = useState<LoopMode>(readLoopMode);
  // A session ended early shows its summary until Resume; a reload brings it back at its card.
  const [endedId, setEndedId] = useState<string | null>(null);
  const [lastReview, setLastReview] = useState<LastReview | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [undoError, setUndoError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // The theme map, kept on the device and refreshed while Today shows (every minute while the server still sorts).
  const [themeState, setThemeState] = useState<ThemeState | null>(null);
  const [sorting, setSorting] = useState<ThemeSorting | null>(null);
  const [themesFailed, setThemesFailed] = useState(false);
  const [themeSync] = useState(() => createThemeSync({
    userId,
    fetchThemes: loadThemes,
    onUpdate: (state, sorted) => {
      setThemeState(state);
      if (!sorted) return;
      setSorting(sorted);
      setThemesFailed(false);
    },
    onError: error => {
      setThemesFailed(true);
      warn('Today could not refresh its themes:', error);
    },
  }));
  // Hiding the tab tears effects down (TabScreen's <Activity>), which stops the refreshes until it shows again.
  useEffect(() => {
    themeSync.start();
    return () => themeSync.stop();
  }, [themeSync]);

  // The plan's snapshot: the library and the theme map as of `now`, taken again on the triggers in the header. Items
  // changing underneath (a review elsewhere, a sync) wait for the next one, so the plan doesn't move under the reader.
  const [planTick, setPlanTick] = useState(0);
  const replan = useCallback(() => setPlanTick(tick => tick + 1), []);
  const now = useNow(useMemo(() => [planTick, themeState], [planTick, themeState]));
  const [snapshot, setSnapshot] = useState(() => ({ now, items, studyItems, themes: themeState }));
  if (snapshot.now !== now || snapshot.themes !== themeState) setSnapshot({ now, items, studyItems, themes: themeState });

  const plan = useMemo(() => planLoop({
    items: snapshot.items,
    themeOf: snapshot.themes?.themes ?? NO_THEMES,
    now: snapshot.now,
    recentStarts: readSetStarts(userId, snapshot.now),
    pin: readTodayPin(userId),
  }), [snapshot, userId]);
  const progress = useMemo(() => loopProgress(snapshot.items, snapshot.now), [snapshot]);
  const classicDue = useMemo(() => countDueSpellings(snapshot.studyItems, snapshot.now), [snapshot]);
  const classicResumable = useMemo(() => classicSavedAt(userId, snapshot.studyItems, snapshot.now) !== null, [userId, snapshot]);

  // The day's pin, kept as the plan made it. Before the theme map is in, the plan has no set at all, which says nothing
  // about today's pin, so it stays.
  useEffect(() => {
    if (!snapshot.themes) return;
    const stored = readTodayPin(userId);
    if (stored?.day !== plan.pin?.day || stored?.themeId !== plan.pin?.themeId) writeTodayPin(userId, plan.pin);
  }, [plan, snapshot.themes, userId]);

  // The plan is taken again when the practice count changes with the clock: an item falling due, or midnight.
  useEffect(() => {
    // A timer holds at most 2^31 - 1 ms; a later change is picked up then.
    const delay = Math.min(Math.max(0, nextPracticeClockChange(snapshot.items, snapshot.now) - Date.now()) + 50, 2 ** 31 - 1);
    const timer = window.setTimeout(replan, delay);
    return () => window.clearTimeout(timer);
  }, [snapshot, replan]);

  // Today's count, the week's sorted items and the streak follow the history as it loads and as reviews land.
  const historyLoaded = reviewHistory.loaded !== false;
  const todayCount = useMemo(() => todaySetCount(reviewHistory, snapshot.now), [reviewHistory, snapshot.now]);
  const sortedCount = useMemo(() => sortedThisWeek(reviewHistory, snapshot.now), [reviewHistory, snapshot.now]);
  const [getSetDays] = useState(() => setDaysLoader(loadSetDays));
  const [setDays, setSetDays] = useState<{ day: string; days: Record<string, number> } | null>(null);
  const day = localDayKey(snapshot.now);
  useEffect(() => {
    let current = true;
    // Offline the streak reads '—' until a later snapshot's load succeeds.
    getSetDays(snapshot.now).then(days => { if (current) setSetDays({ day, days }); }, () => {});
    return () => { current = false; };
  }, [getSetDays, snapshot.now, day]);
  const streak = historyLoaded && setDays?.day === day ? loopStreak(setDays.days, todayCount, snapshot.now) : null;

  // The session's items as they are now: an item deleted, archived or reviewed elsewhere is passed over.
  const playing = session !== null;
  const itemsById = useMemo(() => (playing ? new Map(items.map(item => [item.data.id, item])) : NO_ITEMS), [items, playing]);
  const getItem = useCallback((id: string) => itemsById.get(id), [itemsById]);
  useLayoutEffect(() => {
    if (!session) return;
    const settled = settleSession(session, getItem, () => crypto.randomUUID(), Date.now());
    if (settled !== session) setSession(settled);
  }, [session, getItem]);

  // The session's record, written as its place, choices, attempts or practice mode change, never as a card reveals.
  // A restored session is already written.
  const writtenRef = useRef<LoopSession | null>(initial.session);
  useEffect(() => {
    if (!session || !recordNeedsWrite(writtenRef.current, session)) return;
    writtenRef.current = session;
    writeLoopSession(session, userId, Date.now());
  }, [session, userId]);

  // A practice session keeps the mode it runs in; a set's round records in the current one.
  const sessionMode: LoopMode = session?.kind === 'practice' ? session.mode : mode;
  const currentId = session ? currentItemId(session) : undefined;
  const currentItem = currentId === undefined ? undefined : getItem(currentId);
  const formsOf = useMemo(() => (playing ? sourceFormsLookup(items) : null), [items, playing]);
  const card = useMemo(
    () => (currentItem && formsOf ? loopCard(currentItem, sessionMode, formsOf(currentItem)) : null),
    [currentItem, sessionMode, formsOf],
  );

  const over = !!session && isSessionOver(session);
  const showingSummary = over || (!!session && endedId === session.id);
  const showingCard = screen === 'session' && !!session && !showingSummary && !!currentItem && !!card;
  const footer = showingCard ? cardFooter(session) : null;
  const progressInfo = session ? sessionProgress(session) : null;

  // The session's own audio (loopAudio.ts): an answer, an end or an undo stops what it started, and so does leaving
  // the tab; audio it didn't start plays on.
  const [audio] = useState(() => createLoopAudio(LOOP_AUDIO_ENGINE));
  useEffect(() => () => audio.stopAll(), [audio]);

  // When the last reveal, choice or answer happened, on a clock that never goes back: a footer tap just after it is
  // the second tap of a double tap, and Enter just after a reveal isn't yet Got it (acceptFooterTap).
  const lastActionAtRef = useRef<number | undefined>(undefined);
  const markAction = () => { lastActionAtRef.current = performance.now(); };
  const sessionIdRef = useLatest(session?.id);

  // The session is over for good: a reload brings nothing back.
  const discardSession = useCallback(() => {
    audio.stopAll();
    clearLoopSession(userId);
    writtenRef.current = null;
    setSession(null);
    setEndedId(null);
    setLastReview(null);
    setUndoError('');
    replan();
  }, [audio, userId, replan]);
  // Done, Esc on a summary, or ending before anything was done: back to the plan.
  const closeSession = useCallback(() => {
    discardSession();
    setScreen('plan');
  }, [discardSession]);

  // The plan is taken again as a summary shows, so its next set and tomorrow's count include what the session did.
  useEffect(() => {
    if (showingSummary) replan();
  }, [showingSummary, replan]);
  // A session that ran out having done nothing (its items met or practiced elsewhere meanwhile) just closes, back to
  // the plan if it was on screen; one kept behind Card review goes without moving anything.
  const emptyEnd = over && !!session && !sessionHasProgress(session);
  const sessionOnScreen = screen === 'session';
  useEffect(() => {
    if (!emptyEnd) return;
    if (sessionOnScreen) closeSession();
    else discardSession();
  }, [emptyEnd, sessionOnScreen, closeSession, discardSession]);

  // While the last review waits in the outbox, look every few seconds for it to have reached the server.
  const waitingEventId = lastReview?.waiting ? lastReview.eventId : undefined;
  useEffect(() => {
    if (!waitingEventId) return;
    const timer = window.setInterval(() => {
      if (isQueuedReview(userId, waitingEventId)) return;
      setLastReview(current => (current?.eventId === waitingEventId ? { ...current, waiting: false } : current));
    }, OUTBOX_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [waitingEventId, userId]);

  // On a card a failed undo takes the receipt line's place for a few seconds; the summary keeps its own line.
  useEffect(() => {
    if (!undoError || !showingCard) return;
    const timer = window.setTimeout(() => setUndoError(''), UNDO_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [undoError, showingCard]);

  // The next sentences' clips are fetched as each card shows (never generated), so their answers start at once.
  const cardKey = showingCard ? `${session.id}:${session.kind === 'set' ? session.phase : 'run'}:${progressInfo?.position}` : null;
  const upcomingRef = useLatest({ session, getItem });
  useEffect(() => {
    const { session: shown, getItem: lookup } = upcomingRef.current;
    if (cardKey === null || !shown) return;
    audio.prefetch(upcomingSentences(shown, lookup));
  }, [cardKey, audio, upcomingRef]);

  // What Undo takes back: the run's last recorded answer, else in a set the latest Meet choice (Back), which reaches
  // into a round that hasn't answered anything yet.
  const runUndo = lastReview?.undo && lastReview.sessionId === session?.id ? lastReview : null;
  const backTarget = !runUndo && session?.kind === 'set' ? meetBackTarget(session) : null;
  const undoing = undoingId !== null;
  const canUndo = !!runUndo || !!backTarget;
  let receipt: LoopReceipt | null = null;
  let waiting = false;
  if (runUndo) {
    receipt = runUndo.receipt;
    waiting = runUndo.waiting;
  } else if (backTarget && session?.kind === 'set') {
    const backItem = getItem(backTarget.itemId);
    receipt = meetReceipt(backItem ? itemText(backItem) : '', session.meet.choices[backTarget.itemId].choice);
    waiting = lastReview?.eventId === backTarget.eventId && lastReview.waiting;
  } else if (lastReview && lastReview.sessionId === session?.id) {
    receipt = lastReview.receipt;
  }

  // A run card's captions: where Not yet and Got it lead, and whether Got it makes the item one you can say.
  const runAttempt = session && currentItem ? runOf(session)?.attempts[currentItem.data.id] : undefined;
  const captions = useMemo(() => {
    const stage = attemptStage(runAttempt);
    if (footer !== 'run' || !currentItem || (stage !== 'first' && stage !== 'second')) return null;
    const at = Date.now();
    const base = SRSAlgorithm.ensure(currentItem.srs, currentItem.data.id, currentItem.type);
    const previews = previewRatings(base, at);
    const graduates = updateAfterRating(base, 'good', at, MODE_TASK_TYPES[sessionMode]).sayableAt !== undefined;
    const outcomes = { again: previews.again.nextReview, hard: previews.hard.nextReview, good: previews.good.nextReview };
    return runCaptions(stage, runAttempt?.hinted ?? false, outcomes, graduates, at);
  }, [footer, currentItem, runAttempt, sessionMode]);

  /** Records a review the session's step returned, with its receipt and what undoing it takes. */
  const record = (shown: LoopSession, review: LoopReview, shownReceipt: LoopReceipt, undo?: AttemptUndo) => {
    const { eventId } = review.context;
    setLastReview({ sessionId: shown.id, eventId, receipt: shownReceipt, ...(undo ? { undo } : {}), waiting: false });
    setUndoError('');
    void onReview(review.itemId, review.rating, review.context).then(synced => {
      // Not on the server yet: the receipt says it's saved on this device until the outbox sends it.
      if (synced || !isQueuedReview(userId, eventId)) return;
      setLastReview(current => (current?.eventId === eventId ? { ...current, waiting: true } : current));
    }).catch(error => warn('Review failed:', error));
  };

  const reveal = () => {
    if (!session || !currentItem || !card || session.step !== 'cue' || undoing) return;
    markAction();
    // Inside the tap or key press, where iOS lets the system voice speak.
    audio.sayAnswer(answerSpeech(currentItem, card));
    setSession(current => current && revealAnswer(current));
  };

  const hint = () => {
    if (!session || session.step !== 'cue' || session.hintShown || undoing) return;
    setSession(current => current && takeHint(current));
  };

  const choose = (choice: MeetChoice) => {
    if (session?.kind !== 'set' || !currentItem || undoing) return;
    const at = Date.now();
    const step = chooseInMeet(session, currentItem, choice, crypto.randomUUID(), at);
    if (!step) return;
    audio.stopAll();
    markAction();
    record(session, step.review, meetReceipt(itemText(currentItem), choice));
    setSession(current => (current?.kind === 'set' ? step.advance(current) : current));
  };

  const answer = (gotIt: boolean) => {
    if (!session || !currentItem || undoing) return;
    const at = Date.now();
    const tries = attemptStage(runAttempt) === 'second' ? 2 : 1;
    const step = answerAttempt(session, currentItem, gotIt, at, mode);
    if (!step) return;
    audio.stopAll();
    markAction();
    if (step.review) {
      // The schedule the review leaves, as updateSRS makes it: when the item comes back, or that you can say it now.
      const base = SRSAlgorithm.ensure(currentItem.srs, currentItem.data.id, currentItem.type);
      const after = updateAfterRating(base, step.review.rating, at, step.review.context.taskType);
      const back = practiceReturn(after.nextReview, at);
      const detail = after.sayableAt !== undefined ? 'Can say it now' : back === 'tomorrow' ? 'back tomorrow' : `next ${back}`;
      record(session, step.review, runReceipt(itemText(currentItem), step.review.rating, tries, detail), step.undo);
    }
    setSession(current => current && step.advance(current));
  };

  /** Next: on from saying an item chosen for practice twice, or from the last look at an item missed twice. */
  const goNext = () => {
    if (!session || undoing) return;
    audio.stopAll();
    markAction();
    const at = Date.now();
    setSession(current => {
      if (!current) return current;
      return current.kind === 'set' && current.phase === 'meet' ? finishEncoding(current, at) : finishLook(current, at);
    });
  };

  const replay = () => {
    if (currentItem && card) audio.replay(answerSpeech(currentItem, card));
  };

  const toggleExample = () => {
    if (card?.answer.kind === 'word' && card.answer.example) audio.toggleExample(card.answer.example.text);
  };

  const undo = async () => {
    if (!session || undoing) return;
    const undone = runUndo?.undo;
    const back = backTarget;
    const eventId = undone?.eventId ?? back?.eventId;
    if (!eventId) return;
    audio.stopAll();
    setUndoingId(eventId);
    setUndoError('');
    let failure: UndoFailure;
    try {
      if (await onUndoReview(eventId)) {
        // The session may have ended, or another started, while the undo was on its way; the steps then change nothing.
        const at = Date.now();
        if (undone) setSession(current => applyUndoneAttempt(current, undone, crypto.randomUUID(), at));
        else if (back) setSession(current => (current?.kind === 'set' ? applyMeetBack(current, back, at) : current));
        setLastReview(current => (current?.eventId === eventId ? null : current));
        // An undo from the summary of a session ended early goes back to its card, as one from a finished set does.
        setEndedId(null);
        setUndoingId(null);
        return;
      }
      failure = 'waiting';
    } catch (error) {
      failure = { error };
    }
    setUndoingId(null);
    if (sessionIdRef.current === session.id) setUndoError(undoFailureText(failure, navigator.onLine));
  };

  const begin = (started: LoopSession) => {
    audio.stopAll();
    setEndedId(null);
    setLastReview(null);
    setUndoError('');
    setSession(started);
    setScreen('session');
  };

  const startSet = (set: PlannedSet) => {
    if (set.itemIds.length === 0) return;
    const at = Date.now();
    recordSetStart(userId, set.themeId, at);
    begin(startSetSession(crypto.randomUUID(), set, at));
  };

  // From the library as it is now: an offer the plan made may have been practiced elsewhere since, and then the plan is
  // taken again instead.
  const startPractice = () => {
    const at = Date.now();
    const { itemIds } = practiceQueue(items, at);
    if (itemIds.length > 0) begin(startPracticeSession(crypto.randomUUID(), itemIds, mode, at, () => crypto.randomUUID()));
    else replan();
  };

  // × or Esc on a card: the summary of what was done, or, with nothing done yet, straight back to the plan.
  const endSession = () => {
    if (!session) return;
    audio.stopAll();
    if (sessionHasProgress(session)) setEndedId(session.id);
    else closeSession();
  };

  const changeMode = (value: LoopMode) => {
    setMode(value);
    writeLoopMode(value);
    setSession(current => current && withLoopMode(current, value));
  };

  const backToPlan = useCallback(() => {
    setScreen('plan');
    replan();
  }, [replan]);

  // ↗: the card in the card view among its senses, or the sentence in its lesson, over the session. A Got it given
  // there counts, and the session moves past the item, as it does past any item reviewed elsewhere.
  const openItem = () => {
    if (!currentItem) return;
    if (!isVocabItem(currentItem)) {
      onOpenSentence([currentItem], 0);
      return;
    }
    const { group, index } = openCardGroup(currentItem, studyItems);
    onViewCards([group], 0, index);
  };

  const themesStatus: ThemesStatus = themeState === null
    ? (themesFailed ? 'offline' : 'loading')
    : sorting === null && !themesFailed ? 'loading' : 'ready';
  const sortingShare = sorting && sorting.pending > 0 ? sortingPercent(themeState, sorting.pending) : null;
  const planCard = planCardModel({ progress, todayCount, historyLoaded, next: plan.today, themes: themesStatus, sortingPercent: sortingShare });
  const actions: SummaryAction[] = session && showingSummary
    ? summaryActions(session.kind, progress.practiceDue, todayCount, plan.today)
    : [];

  const summaryAction = (action: SummaryAction) => {
    if (action.kind === 'done') closeSession();
    else if (action.kind === 'set') startSet(action.set);
    else startPractice();
  };
  const planPrimary = () => {
    if (planCard.action.kind === 'practice') startPractice();
    else if (planCard.action.kind === 'set' && plan.today) startSet(plan.today);
  };

  // Esc: back from the themes browser, from a card to its session's summary, or from a summary to the plan. Card review
  // registers its own.
  const listening = todayHandlers(screen, playing, interactionLocked);
  useEscapeLayer(() => {
    if (screen === 'themes') setScreen('plan');
    else if (showingSummary) closeSession();
    else endSession();
  }, 0, listening.escape);

  // Today's keys (todayKeys.ts): one listener while the plan or a session shows and nothing covers the tab, reading
  // what shows as it is now. In the capture phase it gets the keys before the window's shortcuts (1-3 switch tabs), and
  // stops the ones it uses so no other shortcut reacts to them.
  const keyState: Omit<TodayKeyState, 'justRevealed' | 'isMac' | 'typing' | 'onControl' | 'dialogOutside'> = screen === 'plan'
    ? {
      screen: 'plan',
      canUndo: false,
      undoing,
      appUndoOpen: undoOffered,
      hasPrimary: planCard.action.kind === 'practice' || (planCard.action.kind === 'set' && plan.today !== null),
    }
    : showingSummary
      ? { screen: 'summary', canUndo, undoing, appUndoOpen: undoOffered, hasPrimary: actions.length > 0, canResume: !over }
      : {
        screen: 'card',
        footer: footer ?? undefined,
        canHint: !!session && session.step === 'cue' && !session.hintShown,
        sayOpen: !!session && meetChoiceOpen(session, 'say'),
        hasExample: card?.answer.kind === 'word' && !!card.answer.example,
        canUndo,
        undoing,
        appUndoOpen: undoOffered,
      };
  const runKeyAction = (action: TodayKeyAction) => {
    switch (action.type) {
      case 'reveal': reveal(); return;
      case 'hint': hint(); return;
      case 'choose': choose(action.choice); return;
      case 'answer': answer(action.gotIt); return;
      case 'next': goNext(); return;
      case 'play': replay(); return;
      case 'example': toggleExample(); return;
      case 'undo': void undo(); return;
      case 'primary':
        if (screen === 'plan') planPrimary();
        else if (actions[0]) summaryAction(actions[0]);
        return;
      case 'resume': setEndedId(null); return;
      case 'swallow': return;
    }
  };
  const keyContext = useLatest({ keyState, runKeyAction });
  const keysActive = listening.keys;
  useEffect(() => {
    if (!keysActive) return;
    const handleTodayKey = (event: KeyboardEvent) => {
      const { keyState: state, runKeyAction: run } = keyContext.current;
      const action = resolveTodayKey(event, {
        ...state,
        justRevealed: !acceptFooterTap(lastActionAtRef.current, performance.now()),
        isMac: isMacPlatform(),
        typing: isTypingTarget(event.target),
        onControl: isKeyboardFocusedControl(event.target),
        dialogOutside: isDialogOpenOutside(rootRef.current),
      });
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      run(action);
    };
    window.addEventListener('keydown', handleTodayKey, true);
    return () => window.removeEventListener('keydown', handleTodayKey, true);
  }, [keysActive, keyContext]);

  // The footer's buttons ignore a tap that is the second of a double tap; keys act at once.
  const onFooter = <A extends unknown[]>(act: (...args: A) => void) => (...args: A) => {
    if (acceptFooterTap(lastActionAtRef.current, performance.now())) act(...args);
  };

  let content: React.ReactNode;
  if (screen === 'classic') {
    content = (
      <CardReview
        userId={userId}
        items={studyItems}
        reviewHistory={reviewHistory}
        onReview={onReview}
        onUndoReview={onUndoReview}
        onOpenExampleSentence={onOpenExampleSentence}
        onViewCards={onViewCards}
        interactionLocked={interactionLocked}
        onScroll={onScroll}
        onBack={backToPlan}
      />
    );
  } else if (screen === 'themes') {
    content = <ThemesBrowser model={themesBrowserModel(plan)} onBack={() => setScreen('plan')} onStart={startSet} onScroll={onScroll} />;
  } else if (screen === 'session' && session && showingSummary) {
    const practice = session.kind === 'practice' ? summarizePractice(session, getItem) : undefined;
    content = (
      <LoopSummary
        theme={session.kind === 'set' ? themeLabel(session.themeId) : null}
        headline={summaryHeadline(session, !over)}
        set={session.kind === 'set' ? summarizeSet(session) : undefined}
        practice={practice}
        graduated={(practice?.graduated ?? []).flatMap(id => {
          const item = getItem(id);
          return item ? [itemText(item)] : [];
        })}
        tomorrow={progress.tomorrow}
        todayCount={historyLoaded ? todayCount : null}
        actions={actions}
        canUndo={canUndo}
        undoing={undoing}
        undoError={undoError}
        onUndo={() => void undo()}
        onResume={over ? undefined : () => setEndedId(null)}
        onAction={summaryAction}
        onClose={closeSession}
      />
    );
  } else if (showingCard && footer) {
    const inRun = session.kind === 'practice' || session.phase !== 'meet';
    content = (
      <LoopPlayer
        item={currentItem}
        card={card}
        step={session.step}
        hintShown={session.hintShown}
        mode={sessionMode}
        attemptLabel={attemptLabel(session)}
        dots={inRun && session.step !== 'cue' ? graduationDots(currentItem.srs?.stability) : null}
        onOpenItem={openItem}
        onPlaybackStart={audio.own}
        onLazyLoadImage={onLazyLoadImage}
        theme={session.kind === 'set' ? themeLabel(session.themeId) : null}
        position={progressInfo?.position ?? 0}
        total={progressInfo?.total ?? 0}
        phase={session.kind === 'practice' ? 'practice' : session.phase === 'round' ? 'round' : 'meet'}
        onToggleMode={() => changeMode(sessionMode === 'speak' ? 'quiet' : 'speak')}
        footer={footer}
        canHint={session.step === 'cue' && !session.hintShown}
        sayOpen={meetChoiceOpen(session, 'say')}
        captions={captions}
        receipt={receipt}
        undoLabel={backTarget ? 'Back' : 'Undo'}
        canUndo={canUndo}
        undoing={undoing}
        waiting={waiting}
        undoError={undoError}
        onClose={endSession}
        onReveal={onFooter(reveal)}
        onHint={hint}
        onChoose={onFooter(choose)}
        onAnswer={onFooter(answer)}
        onNext={onFooter(goNext)}
        onReplay={replay}
        onUndo={() => void undo()}
      />
    );
  } else if (screen === 'session' && session) {
    // For a frame between two cards, while the session settles past items it can no longer show.
    content = <div className="h-full bg-slate-50" />;
  } else {
    const kept = session && progressInfo ? resumeLabel(session, progressInfo.position, progressInfo.total) : null;
    content = (
      <TodayPlan
        now={snapshot.now}
        card={planCard}
        next={plan.today}
        mode={mode}
        onModeChange={changeMode}
        todayCount={historyLoaded ? todayCount : null}
        streak={streak}
        upNext={plan.upNext.map(set => ({ set, theme: themeLabel(set.themeId) }))}
        hasThemes={plan.themes.size > 0 || plan.unsorted.total > 0}
        progress={progress}
        sortedThisWeek={historyLoaded ? sortedCount : null}
        sorting={sortingShare === null ? null : { percent: sortingShare, ...(sorting?.lastError ? { error: sorting.lastError } : {}) }}
        classicDue={classicDue}
        classicResumable={classicResumable}
        resumeLabel={kept}
        onPractice={startPractice}
        onStartSet={startSet}
        onResume={() => setScreen('session')}
        onThemes={() => setScreen('themes')}
        onClassic={() => setScreen('classic')}
        onScroll={onScroll}
      />
    );
  }
  return <div ref={rootRef} className="h-full" data-today-mode={todayMode(screen, session)}>{content}</div>;
}
