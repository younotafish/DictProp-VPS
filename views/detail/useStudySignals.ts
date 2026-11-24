import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { getPlaybackState, subscribePlayback, type PlaybackState } from '../../services/neuralTts';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { useLatest } from '../../hooks/useStableValue';
import type { StudyExit } from '../../server/src/shared/study-events';
import { flushStudyEvents, queueStudyEvent } from '../../services/studyEvents';
import { StudyExposure, exitBetween } from './studyExposure';

// The lesson's study signals (server/src/shared/study-events.ts): an exposure for each stretch one of the learner's own
// sentences is on screen, counted by StudyExposure, queued as it ends and sent in batches. Nothing on screen changes.
// A copy of the running exposure is queued as the page hides, so a tab closed in the background loses nothing, and the
// finished copy replaces it.

/** What's queued is sent this long after the last exposure ended, so a run of quick moves goes as one request. */
const FLUSH_DELAY_MS = 20_000;

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
  autoPlaying: boolean;
  autoPlayingRef: RefObject<boolean>;
}

const newId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const spokenText = (sentence: StoredItem) => stripSentenceMarkers((sentence.data as SentenceData).text || '').trim();
const isReadStarting = (state: PlaybackState) => state.status === 'loading' || state.status === 'playing';

export function useStudySignals({
  userId, sentence, sessionId, from, position, runLength, analysisOpen, autoPlaying, autoPlayingRef,
}: StudySignalsOptions) {
  const exposureRef = useRef<{ exposure: StudyExposure; text: string } | null>(null);
  const userIdRef = useRef(userId);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read when an exposure starts and ends, without restarting it when they change.
  const latest = useLatest({ sentence, sessionId, from, position, runLength, analysisOpen, autoPlaying });

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
    const now = Date.now();
    if (!current.exposure.worthKeeping(now)) return;
    queueStudyEvent(owner, current.exposure.snapshot(now, exit, true));
    scheduleFlush();
  }, [scheduleFlush]);

  // The sentence at `fromPosition` left for the one now on screen, or for none: the exit is read from where the lesson
  // is now (deliberately the latest values, not those the exposure started with).
  const leaveSentence = useCallback((fromPosition: number) => {
    const next = latest.current;
    const nextPosition = next.sentence && userIdRef.current ? next.position : null;
    endExposure(exitBetween(fromPosition, nextPosition, !!autoPlayingRef.current));
  }, [latest, autoPlayingRef, endExposure]);

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
    const now = Date.now();
    const exposure = new StudyExposure({
      id: newId(),
      itemId: sentenceId,
      sessionId: context.sessionId,
      from: context.from,
      position: context.position,
      runLength: context.runLength,
      learnLater: !!(shown.data as SentenceData).learnLater,
      srs: shown.srs,
    }, now, isVisible());
    exposure.setAnalysisOpen(context.analysisOpen, now);
    if (context.autoPlaying) exposure.noteAutoplay();
    const text = spokenText(shown);
    // A read that began before this effect ran (auto-play moves on and reads at once) still counts here.
    const playback = getPlaybackState();
    if (isReadStarting(playback) && playback.text === text) exposure.notePlay(!!autoPlayingRef.current);
    exposureRef.current = { exposure, text };
    return () => leaveSentence(context.position);
  }, [sentenceId, autoPlayingRef, latest, leaveSentence]);

  useEffect(() => {
    exposureRef.current?.exposure.setAnalysisOpen(analysisOpen, Date.now());
  }, [analysisOpen]);

  useEffect(() => {
    if (autoPlaying) exposureRef.current?.exposure.noteAutoplay();
  }, [autoPlaying]);

  // Time counts only while the page shows. As it hides, a copy of the running exposure is queued and sent with
  // keepalive, so a phone that drops the tab in the background still delivers it.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      const now = Date.now();
      const visible = isVisible();
      const current = exposureRef.current;
      current?.exposure.setVisible(visible, now);
      const owner = userIdRef.current;
      if (visible || !owner) return;
      if (current && current.exposure.worthKeeping(now)) queueStudyEvent(owner, current.exposure.snapshot(now, 'other', false));
      void flushStudyEvents(owner, { keepalive: true });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // A read of the sentence starting: from idle, or from another text. A pause and its resume are the same read.
  useEffect(() => {
    let previous: PlaybackState = getPlaybackState();
    return subscribePlayback(state => {
      const current = exposureRef.current;
      const starting = isReadStarting(state) && state.text !== null &&
        (previous.status === 'idle' || previous.text !== state.text);
      previous = state;
      if (current && starting && state.text === current.text) current.exposure.notePlay(!!autoPlayingRef.current);
    });
  }, [autoPlayingRef]);

  const forSentence = useCallback((id: string | undefined, note: (exposure: StudyExposure) => void) => {
    const current = exposureRef.current;
    if (current && (id === undefined || current.exposure.start.itemId === id)) note(current.exposure);
  }, []);

  return {
    noteListen: useCallback((id: string) => forSentence(id, exposure => exposure.noteListen()), [forSentence]),
    noteGotIt: useCallback((id: string) => forSentence(id, exposure => exposure.noteGotIt(Date.now())), [forSentence]),
    noteStyleSwitch: useCallback(() => forSentence(undefined, exposure => exposure.noteStyleSwitch()), [forSentence]),
    noteLookup: useCallback((term: string) => forSentence(undefined, exposure => exposure.noteLookup(term)), [forSentence]),
    noteCardOpen: useCallback(() => forSentence(undefined, exposure => exposure.noteCardOpen()), [forSentence]),
    noteLearnLater: useCallback((id: string, on: boolean) => forSentence(id, exposure => exposure.setLearnLater(on)), [forSentence]),
  };
}
