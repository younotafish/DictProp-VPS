/**
 * Today, the Study tab: a host that shows the plan, the themes browser, or classic Study as Card review. A unit's
 * sentences open in the Sentences lesson over the tab (App's handleViewSentence), the lesson exactly as the Sentences
 * tab has it, except that its Got its record in the unit's session ('set:<unit id>'), so the day's goal and the streak
 * count them, and its Back says Today.
 *
 * The plan is a snapshot (services/learningLoop/planner.ts) taken as Today shows, as the lesson closes, when the theme
 * map changes, when a unit starts, at local midnight and when the library first arrives on a device that held none,
 * and never while you look at it otherwise, so it holds still. Each snapshot takes up a unit another window of the app
 * has started since. The active unit's progress reads the library as it is now.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemGroup, ReviewHistory, ReviewRating, StoredItem } from '../../types';
import type { SetDaysResponse } from '../../server/src/shared/review';
import type { SentenceRunOptions } from '../../hooks/useDetailView';
import { loadSetDays, loadThemes } from '../../services/api/learningLoop';
import { planLoop, type PlannedSet } from '../../services/learningLoop/planner';
import {
  forgetV3State,
  newerActiveUnit,
  readActiveUnit,
  readSetStarts,
  readTodayPin,
  recordSetStart,
  unitSessionId,
  writeActiveUnit,
  writeTodayPin,
  type ActiveUnit,
} from '../../services/learningLoop/sessionStore';
import { isLoopEligible, localDayStart } from '../../services/learningLoop/standing';
import { loopStreak, setDaysKey, setDaysLoader, todaySetCount, withRecentSetDays } from '../../services/learningLoop/stats';
import { createThemeSync, sortingProgress, type ThemeSorting, type ThemeState } from '../../services/learningLoop/themeMap';
import { warn } from '../../services/logger';
import { needsReview } from '../../services/sentenceOrdering';
import { countDueSpellings } from '../../services/studyStats';
import type { SessionReview } from '../../services/studySession';
import { decodeStudySession, restoreQueue } from '../../services/studySessionRecord';
import { readStoredStudySession } from '../../services/studySessionStore';
import { useEscapeLayer } from '../../components/escapeStack';
import { isDialogOpenOutside, isKeyboardFocusedControl, isTypingTarget } from '../../components/keyboardTarget';
import { useNow } from '../../hooks/useNow';
import { useLatest } from '../../hooks/useStableValue';
import { StudyEnhanced } from '../StudyEnhanced';
import { ThemesBrowser } from './ThemesBrowser';
import { TodayPlan } from './TodayPlan';
import { resolveTodayKey } from './todayKeys';
import {
  planCardModel,
  themesBrowserModel,
  todayHandlers,
  unitExclude,
  unitProgress,
  upNextUnits,
  type ThemesStatus,
  type TodayScreen,
} from './todayModel';

export interface TodayViewProps {
  /** The signed-in user, whose active unit, pin and unit starts this device keeps. */
  userId: string;
  /** The whole library: Today plans from the learner's own sentences in it. */
  items: StoredItem[];
  /** Classic Study's cards (useLibraryViews' studyItems), for Card review. */
  studyItems: StoredItem[];
  /** The review history, and whether a load of it has succeeded yet (useReviewHistory). */
  reviewHistory: ReviewHistory & { loaded?: boolean };
  /** Loads the history again when it's over a minute old (App's refreshReviewHistory), for another device's units. */
  onRefreshHistory?: () => void;
  /** Card review's grades: records a review (App's updateSRS) and takes one back on the server (undoSRSReview). */
  onReview: (itemId: string, rating: ReviewRating, context: SessionReview) => Promise<boolean>;
  onUndoReview: (eventId: string) => Promise<boolean>;
  onOpenExampleSentence: (text: string, sourceWord: string, sourceSense?: string) => void;
  /** Opens the card view on `groups` (App's handleViewStoredItem), for Card review's cards. */
  onViewCards: (groups: ItemGroup[], groupIndex: number, itemIndex: number) => void;
  /** Opens saved sentences in their lesson (App's handleViewSentence): a unit's sentences, with the unit's options. */
  onOpenSentence: (ordered: StoredItem[], index: number, options?: SentenceRunOptions) => void;
  /** Something covers the tab (the lesson, or a card view), which has the keys. As it closes, the plan is taken again. */
  interactionLocked?: boolean;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

const NO_THEMES: ReadonlyMap<string, string> = new Map();

/** How often the history is asked to load again while the plan or the themes browser stays on screen. */
const HISTORY_REFRESH_EVERY_MS = 2 * 60_000;

/** Card review keeps the memo App gave classic Study when it was the tab. */
const CardReview = React.memo(StudyEnhanced);

/** How the lesson opens a unit's sentences: its Got its count toward the goal, and its Back says Today. */
const unitRun = (unit: ActiveUnit): SentenceRunOptions => ({ reviewSessionId: unitSessionId(unit), exitLabel: 'Today' });

/**
 * Whether Card review would take up classic Study's kept session (StudyEnhanced's restoreSession): the user's, recent,
 * and with a card left among `studyItems` that wasn't reviewed since. The plan's Card review row then says Resume.
 */
function classicResumes(userId: string, studyItems: readonly StoredItem[], now: number): boolean {
  const raw = readStoredStudySession();
  const record = raw === null || studyItems.length === 0 ? null : decodeStudySession(raw, userId, now);
  if (!record) return false;
  const byId = new Map(studyItems.map(item => [item.data.id, item]));
  return restoreQueue(record, id => byId.has(id), id => byId.get(id)?.srs?.lastReviewDate ?? 0) !== null;
}

export function TodayView({
  userId,
  items,
  studyItems,
  reviewHistory,
  onRefreshHistory,
  onReview,
  onUndoReview,
  onOpenExampleSentence,
  onViewCards,
  onOpenSentence,
  interactionLocked = false,
  onScroll,
}: TodayViewProps) {
  // Today opens on its plan when the app starts, Card review offering its own Resume there; like every tab, it keeps the
  // screen it shows while the others are in use (TabScreen's <Activity>).
  const [screen, setScreen] = useState<TodayScreen>('plan');
  const rootRef = useRef<HTMLDivElement>(null);

  // What v3 kept on the device, its loop session and its Speak or Quiet mode, goes as Today mounts. The tab's <Activity>
  // runs this again each time Today shows, which then finds nothing to remove.
  useEffect(() => { forgetV3State(userId); }, [userId]);

  // The unit last started on this device, which a start replaces, here or in another window (the snapshot below).
  const [activeUnit, setActiveUnit] = useState<ActiveUnit | null>(() => readActiveUnit(userId));

  // The theme map, kept on the device and refreshed while Today shows: every minute while the server still sorts, and
  // every five minutes otherwise, for the sentences saved since.
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

  // The plan's snapshot: the library, the theme map and the active unit as of `now`, taken again on the triggers in the
  // header. Items changing underneath (a review elsewhere, a sync) wait for the next one, so the plan doesn't move under
  // the reader; only an empty snapshot follows the library as it first arrives (a new device's first pull), since an
  // empty plan has nothing to hold still. The lesson closing takes it again in the same render, so the plan never shows
  // a frame from before. As `now` moves, the snapshot takes up a unit another window started since (newerActiveUnit),
  // so this window offers it as Continue instead of starting another over the same sentences.
  const [planTick, setPlanTick] = useState(0);
  const replan = useCallback(() => setPlanTick(tick => tick + 1), []);
  const [covered, setCovered] = useState(interactionLocked);
  if (covered !== interactionLocked) {
    setCovered(interactionLocked);
    if (!interactionLocked) setPlanTick(tick => tick + 1);
  }
  const now = useNow(useMemo(() => [planTick, themeState], [planTick, themeState]));
  const [snapshot, setSnapshot] = useState(() => ({ now, items, studyItems, themes: themeState, unit: activeUnit }));
  const libraryArrived = snapshot.items.length === 0 && items.length > 0;
  if (libraryArrived || snapshot.now !== now || snapshot.themes !== themeState || snapshot.unit !== activeUnit) {
    const unit = snapshot.now === now ? activeUnit : newerActiveUnit(activeUnit, readActiveUnit(userId));
    if (unit !== activeUnit) setActiveUnit(unit);
    setSnapshot({ now, items, studyItems, themes: themeState, unit });
  }

  // While the active unit is unfinished, no unit the plan composes takes its sentences.
  const plan = useMemo(() => planLoop({
    items: snapshot.items,
    themeOf: snapshot.themes?.themes ?? NO_THEMES,
    now: snapshot.now,
    recentStarts: readSetStarts(userId, snapshot.now),
    pin: readTodayPin(userId),
    exclude: unitExclude(snapshot.unit, snapshot.items, snapshot.now),
  }), [snapshot, userId]);
  // The active unit as the library holds it now, so its progress moves as its sentences are reviewed, here or elsewhere.
  const unit = useMemo(() => unitProgress(snapshot.unit, items, snapshot.now), [snapshot.unit, snapshot.now, items]);
  const classicDue = useMemo(() => countDueSpellings(snapshot.studyItems, snapshot.now), [snapshot]);
  const classicResumable = useMemo(() => classicResumes(userId, snapshot.studyItems, snapshot.now), [userId, snapshot]);

  // The day's pin, kept as the plan made it. Before the theme map is in, or the library on a device that held none, the
  // plan has no unit at all, which says nothing about today's pin, so it stays.
  useEffect(() => {
    if (!snapshot.themes || snapshot.items.length === 0) return;
    const stored = readTodayPin(userId);
    if (stored?.day !== plan.pin?.day || stored?.themeId !== plan.pin?.themeId) writeTodayPin(userId, plan.pin);
  }, [plan, snapshot.themes, snapshot.items, userId]);

  // The plan is taken again at local midnight, for the new day's goal, pin and due sentences.
  useEffect(() => {
    const timer = window.setTimeout(replan, Math.max(0, localDayStart(snapshot.now, 1) - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [snapshot.now, replan]);

  // Today's count and the streak follow the history as it loads and as reviews land.
  const historyLoaded = reviewHistory.loaded !== false;
  const todayCount = useMemo(() => todaySetCount(reviewHistory, snapshot.now), [reviewHistory, snapshot.now]);
  const [getSetDays] = useState(() => setDaysLoader(loadSetDays));
  const [setDays, setSetDays] = useState<{ key: string; response: SetDaysResponse } | null>(null);
  // An answer counts only under the day, offset and zone it was asked for (setDaysKey): after a trip, or past
  // midnight, offline, the streak reads '—' until a later snapshot's load succeeds.
  const setDaysAsked = useMemo(() => setDaysKey(snapshot.now), [snapshot.now]);
  useEffect(() => {
    let current = true;
    getSetDays(snapshot.now).then(response => { if (current) setSetDays({ key: setDaysAsked, response }); }, () => {});
    return () => { current = false; };
  }, [getSetDays, snapshot.now, setDaysAsked]);
  // The days before today count by the server and by this device's recent history, whichever saw more (withRecentSetDays).
  const streak = useMemo(() => (historyLoaded && setDays?.key === setDaysAsked
    ? loopStreak(withRecentSetDays(setDays.response, reviewHistory, snapshot.now), todayCount, snapshot.now)
    : null), [historyLoaded, setDays, setDaysAsked, reviewHistory, todayCount, snapshot.now]);

  // The goal and the streak follow the units other devices finish: the history loads again, once it's over a minute
  // old, as each snapshot is taken, and every two minutes while the page shows the plan or the themes browser
  // uncovered. Card review is left out: a grade there carries the time it was given, which a load already under way
  // can miss until the next.
  useEffect(() => { onRefreshHistory?.(); }, [snapshot.now, onRefreshHistory]);
  useEffect(() => {
    if (!onRefreshHistory || interactionLocked || screen === 'classic') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') onRefreshHistory();
    }, HISTORY_REFRESH_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [onRefreshHistory, interactionLocked, screen]);

  // A cached map whose refresh failed may be from before the server sorted more, so with no unit in it the plan says
  // the themes load online rather than that nothing is left.
  const themesStatus: ThemesStatus = themesFailed ? 'offline' : themeState === null || sorting === null ? 'loading' : 'ready';
  const sortingShare = sortingProgress(plan, sorting);
  const card = planCardModel({
    unit, todayCount, historyLoaded, next: plan.today, themes: themesStatus, sortingPercent: sortingShare, now: snapshot.now,
  });

  // A unit from a planned set: those of its sentences the library still holds that still need review (one gone, or Got
  // it'd elsewhere, since the plan was taken is left out), kept as the active unit and noted as a start from its theme,
  // then opened in the lesson at the first. With none left, or with a unit started in another window since the plan
  // was taken, nothing opens and the plan is taken again, with that window's unit, offered as Continue while unfinished.
  // Back from the lesson is the plan, wherever the unit was started.
  const startUnit = (set: PlannedSet) => {
    const newer = newerActiveUnit(snapshot.unit, readActiveUnit(userId));
    if (newer !== snapshot.unit) {
      setActiveUnit(newer);
      replan();
      return;
    }
    const at = Date.now();
    const ids = new Set(set.itemIds);
    const found = new Map(items
      .filter(item => ids.has(item.data.id) && isLoopEligible(item) && needsReview(item.srs, at))
      .map(item => [item.data.id, item]));
    const sentences = set.itemIds.flatMap(id => found.get(id) ?? []);
    if (sentences.length === 0) {
      replan();
      return;
    }
    const started: ActiveUnit = {
      version: 1, userId, id: crypto.randomUUID(), themeId: set.themeId, itemIds: sentences.map(item => item.data.id), startedAt: at,
    };
    writeActiveUnit(started);
    recordSetStart(userId, set.themeId, at);
    setActiveUnit(started);
    setScreen('plan');
    replan();
    onOpenSentence(sentences, 0, unitRun(started));
  };

  // Continue: the unit's live sentences in the lesson, at the first that still needs review.
  const continueUnit = () => {
    if (!unit || unit.next < 0) replan();
    else onOpenSentence(unit.items, unit.next, unitRun(unit.unit));
  };

  const pressPrimary = () => {
    if (card.kind === 'continue') continueUnit();
    else if (card.kind === 'start') startUnit(card.set);
  };

  const backToPlan = useCallback(() => {
    setScreen('plan');
    replan();
  }, [replan]);

  // Esc in the themes browser goes back to the plan. Card review registers its own.
  const listening = todayHandlers(screen, interactionLocked);
  useEscapeLayer(() => setScreen('plan'), 0, listening.escape);

  // Enter on the plan (todayKeys.ts): one listener while the plan shows and nothing covers the tab, reading the card as
  // it is now. In the capture phase it gets the key before the window's shortcuts, and stops it when it acts, so no
  // other shortcut reacts to it.
  const keyContext = useLatest({ hasPrimary: card.kind === 'continue' || card.kind === 'start', pressPrimary });
  const keysActive = listening.keys;
  useEffect(() => {
    if (!keysActive) return;
    const handleTodayKey = (event: KeyboardEvent) => {
      const { hasPrimary, pressPrimary: press } = keyContext.current;
      const action = resolveTodayKey(event, {
        hasPrimary,
        typing: isTypingTarget(event.target),
        onControl: isKeyboardFocusedControl(event.target),
        dialogOutside: isDialogOpenOutside(rootRef.current),
      });
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      press();
    };
    window.addEventListener('keydown', handleTodayKey, true);
    return () => window.removeEventListener('keydown', handleTodayKey, true);
  }, [keysActive, keyContext]);

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
    content = (
      <ThemesBrowser
        model={themesBrowserModel(plan)}
        onBack={() => setScreen('plan')}
        onStart={startUnit}
        onContinue={continueUnit}
        onScroll={onScroll}
      />
    );
  } else {
    content = (
      <TodayPlan
        now={snapshot.now}
        card={card}
        todayCount={historyLoaded ? todayCount : null}
        streak={streak}
        upNext={upNextUnits(card, plan)}
        hasThemes={plan.themes.size > 0 || plan.unsorted.total > 0}
        sorting={sortingShare === null ? null : { percent: sortingShare, ...(sorting?.lastError ? { error: sorting.lastError } : {}) }}
        classicDue={classicDue}
        classicResumable={classicResumable}
        onContinue={continueUnit}
        onStartUnit={startUnit}
        onThemes={() => setScreen('themes')}
        onClassic={() => setScreen('classic')}
        onScroll={onScroll}
      />
    );
  }
  return <div ref={rootRef} className="h-full" data-today-mode={screen}>{content}</div>;
}
