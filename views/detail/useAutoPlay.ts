import { useCallback, useEffect, useRef, useState } from 'react';
import { primeKeepAlive } from '../../services/neuralTts';
import { createSessionClock, type SessionClock } from '../../services/audio/autoplayController';
import { useLatest } from '../../hooks/useStableValue';
import { useWakeLock } from './useWakeLock';

// The settings each auto-play control cycles through.
const SPEED_PRESETS = [1000, 1500, 2000, 3000, 5000];   // ms each slide shows
const TIMER_PRESETS = [5, 10, 15, 20, 25];               // minutes before auto-play stops itself
const GAP_PRESETS = [2000, 3000, 5000, 10000];           // ms of silence between reads
const REPEAT_PRESETS = [1, 2, 3, 4, 5];                  // times each sentence is read

const nextPreset = <T,>(presets: readonly T[], current: T): T => presets[(presets.indexOf(current) + 1) % presets.length];

/** Which auto-play runs: none, the word slideshow, or the sentence reader. One state, so the two never run at once. */
export type AutoPlayMode = 'off' | 'slideshow' | 'examples';

/**
 * The card view's two auto-play modes and their settings. The word slideshow (isAutoPlaying) steps through the
 * cards; sentence auto-play (isSentenceAutoPlaying) reads each card's example sentences, or in sentence review
 * the sentence itself. Only one runs at a time. Either keeps the screen awake, and stops itself when its timer
 * runs out. Sentence auto-play can pause (its reader reports it through setSentenceAutoPlayPaused): the timer stands
 * still meanwhile, and the screen stays awake for the pause's first two minutes only.
 */
export function useAutoPlay() {
  const [autoPlayMode, setAutoPlayMode] = useState<AutoPlayMode>('off');
  const isAutoPlaying = autoPlayMode === 'slideshow';
  const isSentenceAutoPlaying = autoPlayMode === 'examples';
  const [autoPlaySpeed, setAutoPlaySpeed] = useState(2000); // ms
  const [autoPlayTimerMinutes, setAutoPlayTimerMinutes] = useState(20);
  const isSentenceAutoPlayingRef = useLatest(isSentenceAutoPlaying);
  const [sentenceGap, setSentenceGap] = useState(2000); // ms of silence between every read (repeats + distinct sentences)
  const [sentenceRepeats, setSentenceRepeats] = useState(3); // times each sentence is read (total), 1–5
  const [sentenceAutoPlayPaused, setPausedState] = useState(false);

  // The timer's clock, one per run of either mode: the time spent paused doesn't count.
  const [clock, setClock] = useState<SessionClock | null>(null);
  const clockRef = useRef<SessionClock | null>(null);

  // Keep the screen awake while EITHER auto-play mode is active, so the phone doesn't auto-dim/lock and pause
  // playback; the browser lets the lock go whenever the page is hidden, and it's taken again on the way back
  // (useWakeLock), and a pause keeps it for two minutes only. Requires HTTPS + iOS 16.4+; a manual lock still suspends.
  const { rearm: rearmWakeLock } = useWakeLock(isAutoPlaying || isSentenceAutoPlaying, sentenceAutoPlayPaused);

  /** Sentence auto-play paused or resumed: the timer stands still while it's paused. */
  const setSentenceAutoPlayPaused = useCallback((paused: boolean) => {
    const current = clockRef.current;
    if (current) {
      if (paused) current.pause();
      else current.resume();
    }
    setPausedState(paused);
  }, []);

  /** After a pause: take the screen lock and the silent keep-alive again, which the system may have let go meanwhile. */
  const rearmAutoPlay = useCallback(() => {
    primeKeepAlive();
    rearmWakeLock();
  }, [rearmWakeLock]);

  // How long each slide shows; useWordSlideshow reads it as each slide starts.
  const autoPlaySpeedRef = useLatest(autoPlaySpeed);

  const cycleSpeed = useCallback(() => {
    setAutoPlaySpeed(prev => nextPreset(SPEED_PRESETS, prev));
  }, []);

  const cycleTimerDuration = useCallback(() => {
    setAutoPlayTimerMinutes(prev => nextPreset(TIMER_PRESETS, prev));
  }, []);

  const toggleAutoPlay = useCallback(() => {
    setAutoPlayMode(mode => mode === 'slideshow' ? 'off' : 'slideshow');
  }, []);

  // Each stop ends its own mode and leaves the other running; stopAutoPlay ends whichever runs.
  const stopSlideshow = useCallback(() => {
    setAutoPlayMode(mode => mode === 'slideshow' ? 'off' : mode);
  }, []);
  const stopSentenceAutoPlay = useCallback(() => {
    setAutoPlayMode(mode => mode === 'examples' ? 'off' : mode);
  }, []);
  const stopAutoPlay = useCallback(() => setAutoPlayMode('off'), []);

  // ── Sentence auto-play: read each card's example sentences (both) in turn (neural voice) ──
  const cycleGap = useCallback(() => {
    setSentenceGap(prev => nextPreset(GAP_PRESETS, prev));
  }, []);

  // How many times each sentence is read (total), cycled 1 → 5 → 1.
  const cycleRepeats = useCallback(() => {
    setSentenceRepeats(prev => nextPreset(REPEAT_PRESETS, prev));
  }, []);

  const toggleSentenceAutoPlay = useCallback(() => {
    setAutoPlayMode(mode => mode === 'examples' ? 'off' : 'examples');
    // Prime the silent keep-alive inside this user gesture so iOS unlocks it (the registration effect's
    // acquire runs after paint, outside the gesture). Priming takes no hold — the media-session effect's
    // acquire/release pair owns the lifecycle. Harmless when stopping — that effect's cleanup releases it.
    primeKeepAlive();
  }, []);

  const sentenceGapRef = useLatest(sentenceGap);
  const sentenceRepeatsRef = useLatest(sentenceRepeats);

  // Timer: a fresh clock for each run (either mode, or a switch between them), none while stopped.
  useEffect(() => {
    const next = autoPlayMode === 'off' ? null : createSessionClock(() => Date.now());
    next?.start();
    clockRef.current = next;
    setClock(next);
    setPausedState(false);
  }, [autoPlayMode]);

  // What the timer's end does while sentence auto-play reads: its reader lets the read under way finish first. With
  // nothing registered (the slideshow) auto-play stops at once.
  const timerExpiryRef = useRef<(() => void) | null>(null);
  const setTimerExpiry = useCallback((onExpired: (() => void) | null) => { timerExpiryRef.current = onExpired; }, []);

  // Stop auto-play when the timer expires; a paused session's timer stands still, so it can't run out. The check sets
  // no state until then, so the card doesn't re-render every second; AutoPlayCountdown shows the time left.
  const durationMs = autoPlayTimerMinutes * 60_000;
  useEffect(() => {
    if (!clock) return;
    const interval = setInterval(() => {
      if (clock.isPaused() || clock.remainingMs(durationMs) > 0) return;
      const onExpired = timerExpiryRef.current;
      if (onExpired) onExpired();
      else setAutoPlayMode('off');
    }, 1000);
    return () => clearInterval(interval);
  }, [clock, durationMs]);

  /** What's left of the Duration, the time spent paused not counted; all of it while auto-play is off. */
  const durationMsRef = useLatest(durationMs);
  const remainingMs = useCallback(() => {
    const current = clockRef.current;
    return current ? current.remainingMs(durationMsRef.current) : durationMsRef.current;
  }, [durationMsRef]);

  // The countdown: while running, when its run began, moved on by the time spent paused (so it ends at start +
  // Duration); while paused, the time left, standing still.
  const runningDeadline = clock && !sentenceAutoPlayPaused ? clock.deadline(durationMs) : null;
  const countdownStartedAt = runningDeadline === null ? null : runningDeadline - durationMs;
  const countdownFrozenMs = clock && sentenceAutoPlayPaused ? clock.remainingMs(durationMs) : null;

  return {
    isAutoPlaying, isSentenceAutoPlaying, isSentenceAutoPlayingRef, stopAutoPlay, stopSlideshow, stopSentenceAutoPlay,
    autoPlaySpeed, autoPlaySpeedRef, cycleSpeed, autoPlayTimerMinutes, cycleTimerDuration, countdownStartedAt,
    countdownFrozenMs, sentenceGap, sentenceGapRef, cycleGap, sentenceRepeats, sentenceRepeatsRef, cycleRepeats,
    toggleAutoPlay, toggleSentenceAutoPlay, sentenceAutoPlayPaused, setSentenceAutoPlayPaused, setTimerExpiry,
    rearmAutoPlay, remainingMs,
  };
}
