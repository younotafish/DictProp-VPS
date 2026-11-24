import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { getPlaybackState, getPlaybackToken, subscribePlayback, type PlaybackState } from '../../services/neuralTts';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { deviceKind } from '../../services/platform';
import { isTypingTarget } from '../../components/keyboardTarget';
import { useLatest } from '../../hooks/useStableValue';
import type { StudyExit } from '../../server/src/shared/study-events';
import { flushStudyEvents, queueStudyEvent } from '../../services/studyEvents';
import { StudyExposure, exitBetween } from './studyExposure';

// The lesson's study signals (server/src/shared/study-events.ts): an exposure for each stretch one of the learner's own
// sentences is on screen, counted by StudyExposure, queued as it ends and sent in batches. Nothing on screen changes.
// Time counts only while the lesson is attended: the page visible, its window focused, and nothing over it (a word
// card's popup, the search results, a dialog). The learner's own taps, keys, scrolls and swipes on the lesson, and the
// sentence's audio, tell engaged time from a screen left on. Every duration runs on performance.now(), so a device
// clock set back or forward can't bend one. A copy of the running exposure is queued and sent as the page hides, so a
// tab dropped in the background loses nothing, and the finished copy replaces it.

/** What's queued is sent this long after the last exposure ended, so a run of quick moves goes as one request. */
const FLUSH_DELAY_MS = 20_000;
/** How often a cover that came or went without an action on the lesson (closing a popup with its X) is noticed. */
const COVER_CHECK_MS = 2_000;

interface StudySignalsOptions {
  /** The signed-in user, whose queue the signals go to; without one nothing is recorded. */
  userId: string | undefined;
  /** The sentence on screen when it's one of the learner's own saved sentences, else null (nothing is recorded). */
  sentence: StoredItem | null;
  sessionId: string | undefined;
  from: string | undefined;
  /** The sentence's place in the run (1-based) and the run's length. */
  position: number;
  runLength: number;
  analysisOpen: boolean;
  /** Whether the sentence on screen is starred Learn later (services/learnLater.ts). */
  learnLater: boolean;
  /** Whether this device has read the server's stars, so `learnLater` false means not starred, not unknown. */
  learnLaterKnown: boolean;
  autoPlaying: boolean;
  autoPlayingRef: RefObject<boolean>;
  /** The lesson's root: only input inside it (or keys not typed into a field) is the learner on the lesson. */
  rootRef: RefObject<HTMLElement | null>;
  /** Whether something covers the lesson now (a word card's popup, the search results, a dialog): time stops. */
  isCovered: () => boolean;
}

const newId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const monotonicNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

const DEVICE = typeof navigator === 'undefined' ? undefined : deviceKind(navigator);
const IS_IOS = DEVICE === 'iphone' || DEVICE === 'ipad';

/**
 * Whether the window has focus. On an iPhone or iPad from its focus and blur events alone, since document.hasFocus()
 * isn't reported reliably there (a false would zero every time): the lesson opens from a tap, so it starts focused, a
 * blur (another app, Split View's other side) clears it, and a focus, the page showing again or an action on the
 * lesson sets it. On a desktop the browser's own document.hasFocus() is reliable, so a window shown again behind
 * another app's stays unattended until it really has focus.
 */
let windowFocused = true;
/** False between pagehide and pageshow: a page being put away, whatever visibilityState still says. */
let pageShown = true;
const readWindowFocus = (): boolean =>
  IS_IOS || typeof document === 'undefined' || typeof document.hasFocus !== 'function' ? true : document.hasFocus();

/** Installed (home screen, Dock) rather than in a browser tab: iOS's own flag, else the display mode. */
const isStandalone = (): boolean | undefined => {
  if (typeof window === 'undefined') return undefined;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (iosStandalone !== undefined) return iosStandalone;
  return !!window.matchMedia?.('(display-mode: standalone)')?.matches;
};
/** What counts as the learner doing something, for engaged time. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const spokenText = (sentence: StoredItem) => stripSentenceMarkers((sentence.data as SentenceData).text || '').trim();
const isReadActive = (state: PlaybackState) => state.status === 'loading' || state.status === 'playing';

export function useStudySignals({
  userId, sentence, sessionId, from, position, runLength, analysisOpen, learnLater, learnLaterKnown, autoPlaying,
  autoPlayingRef, rootRef, isCovered,
}: StudySignalsOptions) {
  // The page's lifecycle as the lesson first renders, before its first exposure is made: a desktop reads its real
  // focus (the learner may have switched apps while the lesson loaded), an iPhone or iPad starts focused.
  useState(() => {
    windowFocused = readWindowFocus();
    pageShown = true;
    return null;
  });
  const exposureRef = useRef<{ exposure: StudyExposure; text: string } | null>(null);
  const userIdRef = useRef(userId);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCoveredRef = useLatest(isCovered);
  // Read when an exposure starts and ends, without restarting it when they change.
  const latest = useLatest({
    sentence, sessionId, from, position, runLength, analysisOpen, learnLater, learnLaterKnown, autoPlaying,
  });
  // The learner's last action on the lesson (monotonic), carried into the next exposure, so auto-play moving on
  // grants no fresh idle allowance; set as the lesson opens, which a tap or key did.
  const lastActionRef = useRef(monotonicNow());
  // A move the learner made (a key, a swipe) and its direction, so the exposure it ends is labelled by it, not as
  // auto-play's, whatever auto-play's state; set only when the move really changed the sentence.
  const manualMoveRef = useRef<'next' | 'prev' | null>(null);
  // The read already counted, by the player's request number, so a pause and its resume, or a load paused before it
  // played, count once.
  const countedReadRef = useRef<number | null>(null);

  // Attended: the page visible, its window focused, and nothing over the lesson.
  // A desktop asks the browser for its focus each time (document.hasFocus() is reliable there, so no blur can be
  // missed); an iPhone or iPad goes by its focus and blur events.
  const isAttended = useCallback(
    () => pageShown && isVisible() && (IS_IOS ? windowFocused : readWindowFocus()) && !isCoveredRef.current(),
    [isCoveredRef],
  );

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      if (userIdRef.current) void flushStudyEvents(userIdRef.current);
    }, FLUSH_DELAY_MS);
  }, []);

  const endExposure = useCallback((exit: StudyExit) => {
    const current = exposureRef.current;
    exposureRef.current = null;
    const owner = userIdRef.current;
    if (!current || !owner) return;
    const now = monotonicNow();
    if (!current.exposure.worthKeeping(now)) return;
    queueStudyEvent(owner, current.exposure.snapshot(now, exit, true));
    scheduleFlush();
  }, [scheduleFlush]);

  // The sentence at `fromPosition` left for the one now on screen, or for none: a move the learner made says its own
  // direction; otherwise the exit is read from where the lesson is now (deliberately the latest values).
  const leaveSentence = useCallback((fromPosition: number) => {
    const manual = manualMoveRef.current;
    manualMoveRef.current = null;
    const next = latest.current;
    if (manual && next.sentence && userIdRef.current) {
      endExposure(manual);
      return;
    }
    const nextPosition = next.sentence && userIdRef.current ? next.position : null;
    endExposure(exitBetween(fromPosition, nextPosition, !!autoPlayingRef.current));
  }, [latest, autoPlayingRef, endExposure]);

  /** A copy of the running exposure, queued (and returned) for a page that may not come back. */
  const checkpoint = useCallback(() => {
    const current = exposureRef.current;
    const owner = userIdRef.current;
    const now = monotonicNow();
    if (!current || !owner || !current.exposure.worthKeeping(now)) return undefined;
    const copy = current.exposure.snapshot(now, 'other', false);
    queueStudyEvent(owner, copy);
    return copy;
  }, []);

  // What was queued earlier, offline or in a lesson closed before its flush, goes as the lesson opens.
  useEffect(() => {
    userIdRef.current = userId;
    if (userId) void flushStudyEvents(userId);
  }, [userId]);

  // The lesson closing ends the exposure as 'close' and sends what's queued. Declared before the sentence effect: on
  // unmount React runs the cleanups in order, so this one ends the exposure first and the sentence effect's cleanup
  // finds nothing left to end.
  useEffect(() => () => {
    endExposure('close');
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    if (userIdRef.current) void flushStudyEvents(userIdRef.current);
  }, [endExposure]);

  // A new sentence on screen ends the last exposure and starts the next.
  const sentenceId = userId && sentence ? sentence.data.id : null;
  useEffect(() => {
    const { sentence: shown, ...context } = latest.current;
    if (!sentenceId || !shown) return;
    const now = monotonicNow();
    const attended = isAttended();
    const exposure = new StudyExposure({
      id: newId(),
      itemId: sentenceId,
      sessionId: context.sessionId,
      from: context.from,
      position: context.position,
      runLength: context.runLength,
      learnLater: context.learnLater,
      learnLaterKnown: context.learnLaterKnown,
      srs: shown.srs,
      device: DEVICE,
      standalone: isStandalone(),
    }, now, attended, undefined, { wallStart: Date.now(), lastAction: lastActionRef.current });
    exposure.setAnalysisOpen(context.analysisOpen, now);
    if (context.autoPlaying) exposure.noteAutoplay();
    const text = spokenText(shown);
    // A read that began before this effect ran (auto-play moves on and reads at once) still counts here.
    const playback = getPlaybackState();
    if (isReadActive(playback) && playback.text === text) {
      const token = getPlaybackToken();
      if (countedReadRef.current !== token) {
        countedReadRef.current = token;
        exposure.notePlay(!!autoPlayingRef.current);
      }
    }
    exposure.setPlaying(playback.status === 'playing' && playback.text === text, now);
    exposureRef.current = { exposure, text };
    // Started with the lesson out of sight (auto-play moving on behind a locked screen): a copy at once, since the
    // page can be dropped before this exposure ends.
    if (!attended) checkpoint();
    return () => leaveSentence(context.position);
  }, [sentenceId, autoPlayingRef, latest, leaveSentence, isAttended, checkpoint]);

  // The star as this device knows it, so one set or taken away on another device and read here ends the exposure as
  // it stands. learnLaterAtStart keeps how it began; a toggle made here is counted where it's made.
  useEffect(() => {
    exposureRef.current?.exposure.setLearnLater(learnLater);
  }, [sentenceId, learnLater]);

  useEffect(() => {
    exposureRef.current?.exposure.setAnalysisOpen(analysisOpen, monotonicNow());
  }, [analysisOpen]);

  useEffect(() => {
    if (autoPlaying) exposureRef.current?.exposure.noteAutoplay();
  }, [autoPlaying]);

  // Attention: visibility, focus, covers, and the learner's own input on the lesson. As the page hides (or is torn
  // down: pagehide, which iOS can send where it skips visibilitychange) the clock stops, and a copy of the running
  // exposure is sent first with keepalive, so a phone that drops the tab in the background still delivers it.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const reconcile = () => {
      const current = exposureRef.current;
      if (!current) return;
      const attended = isAttended();
      if (attended === current.exposure.attended) return;
      const now = monotonicNow();
      // Coming back to the lesson is evidence the learner is there, for the exposures after this one too.
      if (attended) lastActionRef.current = now;
      current.exposure.setVisible(attended, now);
    };
    const onFocus = () => { windowFocused = true; reconcile(); };
    // Losing focus stops the clock and keeps a copy: a desktop tab can be discarded later without a pagehide.
    const onBlur = () => { windowFocused = false; reconcile(); checkpoint(); };
    const onHidden = () => {
      reconcile();
      const owner = userIdRef.current;
      if (!owner) return;
      const copy = checkpoint();
      void flushStudyEvents(owner, { keepalive: true, current: copy });
    };
    const onVisibility = () => {
      if (isVisible()) {
        pageShown = true;
        windowFocused = readWindowFocus();
        reconcile();
        if (userIdRef.current) void flushStudyEvents(userIdRef.current);
      } else {
        onHidden();
      }
    };
    const onPageHide = () => { pageShown = false; onHidden(); };
    const onPageShow = () => {
      pageShown = true;
      windowFocused = readWindowFocus();
      reconcile();
      if (userIdRef.current) void flushStudyEvents(userIdRef.current);
    };
    // What waited while offline goes as the connection comes back.
    const onOnline = () => { if (userIdRef.current) void flushStudyEvents(userIdRef.current); };
    const onActivity = (event: Event) => {
      const current = exposureRef.current;
      if (!current) return;
      const target = event.target instanceof Node ? event.target : null;
      // Input elsewhere (the search box, a popup, a dialog) is the learner away from the lesson: it renews nothing.
      // Keys count unless typed into a field, since the lesson's keys arrive at the page, not inside it.
      // A key counts when it reaches the page itself (the lesson's shortcuts) or a control in the lesson, never one
      // typed into a field or pressed on a control elsewhere (the floating search's buttons).
      const onLesson = event.type === 'keydown'
        ? !isTypingTarget(event.target) && (target === document.body || target === document.documentElement ||
          target === document || !!(target && rootRef.current?.contains(target)))
        : !!target && !!rootRef.current?.contains(target);
      if (isCoveredRef.current() || !onLesson) {
        reconcile();
        return;
      }
      // A wheel turned over a window in the background (macOS scrolls one without focusing it) proves nothing.
      if (event.type === 'wheel' && !current.exposure.attended) return;
      // An action on the lesson proves its window has focus, whatever the browser reported (some send focus late).
      windowFocused = true;
      const now = monotonicNow();
      lastActionRef.current = now;
      reconcile();
      current.exposure.noteActivity(now);
    };
    // A cover that came or went without an action on the lesson (a popup opened from the keyboard, or closed with its
    // X) is noticed within seconds.
    const coverCheck = setInterval(reconcile, COVER_CHECK_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('online', onOnline);
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { capture: true, passive: true });
    return () => {
      clearInterval(coverCheck);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('online', onOnline);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, { capture: true });
    };
  }, [checkpoint, isAttended, isCoveredRef, rootRef]);

  // Reads of the sentence: each counted once, by the player's request number, and its playing time engaged in full.
  // A read started with the lesson out of sight (auto-play behind a locked screen) checkpoints the exposure.
  useEffect(() => subscribePlayback(state => {
    const current = exposureRef.current;
    if (!current) return;
    const ours = state.text === current.text;
    if (ours && isReadActive(state)) {
      const token = getPlaybackToken();
      if (countedReadRef.current !== token) {
        countedReadRef.current = token;
        current.exposure.notePlay(!!autoPlayingRef.current);
        if (!current.exposure.attended) checkpoint();
      }
    }
    current.exposure.setPlaying(ours && state.status === 'playing', monotonicNow());
  }), [autoPlayingRef, checkpoint]);

  const forSentence = useCallback((id: string | undefined, note: (exposure: StudyExposure) => void) => {
    const current = exposureRef.current;
    if (current && (id === undefined || current.exposure.start.itemId === id)) note(current.exposure);
  }, []);

  return {
    // A read heard to its end while the lesson isn't attended (auto-play behind a locked screen) checkpoints the
    // exposure, since the page may be dropped before it ends.
    noteListen: useCallback((id: string) => forSentence(id, exposure => {
      exposure.noteListen();
      if (!exposure.attended) checkpoint();
    }), [forSentence, checkpoint]),
    /** The learner moved to another sentence (a key, a swipe); call only when the move changes the sentence. */
    noteManualMove: useCallback((direction: 'next' | 'prev') => { manualMoveRef.current = direction; }, []),
    noteGotIt: useCallback((id: string) => forSentence(id, exposure => exposure.noteGotIt(monotonicNow())), [forSentence]),
    noteStyleSwitch: useCallback(() => forSentence(undefined, exposure => exposure.noteStyleSwitch()), [forSentence]),
    noteLookup: useCallback((term: string) => forSentence(undefined, exposure => exposure.noteLookup(term)), [forSentence]),
    noteCardOpen: useCallback(() => forSentence(undefined, exposure => exposure.noteCardOpen()), [forSentence]),
    noteLearnLater: useCallback(
      (id: string, on: boolean) => forSentence(id, exposure => exposure.setLearnLater(on, true)),
      [forSentence],
    ),
  };
}
