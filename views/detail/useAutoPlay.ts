import { useCallback, useEffect, useState } from 'react';
import { primeKeepAlive } from '../../services/lazyTts';
import { useLatest } from '../../hooks/useStableValue';

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
 * runs out.
 */
export function useAutoPlay() {
  const [autoPlayMode, setAutoPlayMode] = useState<AutoPlayMode>('off');
  const isAutoPlaying = autoPlayMode === 'slideshow';
  const isSentenceAutoPlaying = autoPlayMode === 'examples';
  const [autoPlaySpeed, setAutoPlaySpeed] = useState(2000); // ms
  const [autoPlayTimerMinutes, setAutoPlayTimerMinutes] = useState(20);
  const [autoPlayStartedAt, setAutoPlayStartedAt] = useState<number | null>(null);
  const isSentenceAutoPlayingRef = useLatest(isSentenceAutoPlaying);
  const [sentenceGap, setSentenceGap] = useState(2000); // ms of silence between every read (repeats + distinct sentences)
  const [sentenceRepeats, setSentenceRepeats] = useState(3); // times each sentence is read (total), 1–5

  // Keep the screen awake while EITHER auto-play mode is active, so the phone doesn't
  // auto-dim/lock and pause playback. Wake lock auto-releases when the tab is hidden, so we
  // re-acquire on visibilitychange. (Requires HTTPS + iOS 16.4+; manual lock still suspends.)
  useEffect(() => {
    if (!isAutoPlaying && !isSentenceAutoPlaying) return;
    const wakeLockApi = (navigator as Partial<Pick<Navigator, 'wakeLock'>>).wakeLock;
    if (!wakeLockApi?.request) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await wakeLockApi.request('screen');
        if (cancelled) { lock.release?.(); return; }
        sentinel = lock;
      } catch {
        // Ignore — user may have denied, or document not visible
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinel) acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      sentinel?.release?.();
      sentinel = null;
    };
  }, [isAutoPlaying, isSentenceAutoPlaying]);

  // Auto-play slideshow effect
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

  // Timer: stamp start time on play, clear on stop (covers both word- and sentence-autoplay)
  useEffect(() => {
    setAutoPlayStartedAt((isAutoPlaying || isSentenceAutoPlaying) ? Date.now() : null);
  }, [isAutoPlaying, isSentenceAutoPlaying]);

  // Stop auto-play when the timer expires. The check sets no state until then, so the card doesn't
  // re-render every second; AutoPlayCountdown shows the time left.
  useEffect(() => {
    if ((!isAutoPlaying && !isSentenceAutoPlaying) || autoPlayStartedAt === null) return;
    const interval = setInterval(() => {
      if (Date.now() - autoPlayStartedAt >= autoPlayTimerMinutes * 60_000) setAutoPlayMode('off');
    }, 1000);
    return () => clearInterval(interval);
  }, [isAutoPlaying, isSentenceAutoPlaying, autoPlayStartedAt, autoPlayTimerMinutes]);

  const countdownStartedAt = isAutoPlaying || isSentenceAutoPlaying ? autoPlayStartedAt : null;

  return {
    isAutoPlaying, isSentenceAutoPlaying, isSentenceAutoPlayingRef, stopAutoPlay, stopSlideshow, stopSentenceAutoPlay,
    autoPlaySpeed, autoPlaySpeedRef, cycleSpeed, autoPlayTimerMinutes, cycleTimerDuration, countdownStartedAt,
    sentenceGap, sentenceGapRef, cycleGap, sentenceRepeats, sentenceRepeatsRef, cycleRepeats,
    toggleAutoPlay, toggleSentenceAutoPlay,
  };
}

export type AutoPlay = ReturnType<typeof useAutoPlay>;
