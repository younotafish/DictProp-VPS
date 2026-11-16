import { useCallback, useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { getItemImageUrl, type ItemGroup, type StoredItem } from '../../types';
import {
  acquireKeepAlive, afterGap, getPlaybackState, pauseCurrent, releaseKeepAlive, reservePlayback, resumeCurrent,
  setMediaMetadata, setMediaSessionHandlers, setPlaybackStateOverride, speakNatural, subscribePlayback,
} from '../../services/neuralTts';
import { createAutoplayController, type AutoplayController } from '../../services/audio/autoplayController';
import { useLatest } from '../../hooks/useStableValue';

interface AutoPlayReaderOptions {
  /** Sentence auto-play is on (word cards: their examples; sentence review: the sentence). */
  active: boolean;
  /** Ends sentence auto-play: after the last card, or from the lock screen's Stop. */
  stop: () => void;
  /** Times each sentence is read, and the silence between reads, read as the chain goes. */
  repeatsRef: RefObject<number>;
  gapRef: RefObject<number>;
  groups: ItemGroup[];
  currentGroupIndex: number;
  currentItemIndex: number;
  setCurrentGroupIndex: Dispatch<SetStateAction<number>>;
  setCurrentItemIndex: Dispatch<SetStateAction<number>>;
  currentGroupIndexRef: RefObject<number>;
  /** The card on screen (in sentence review, the sentence's source card), for the lock-screen picture. */
  currentItem: StoredItem;
  /**
   * Sentence review reads one saved sentence per card, waits the configurable gap between cards as well as
   * between reads, and counts a fully heard round as a listen. Word cards read their examples and take a short
   * beat between cards.
   */
  sentenceReview: boolean;
  /** Sentence review's list, which bounds the lock screen's next and previous. Word cards use their groups. */
  sentenceItemsRef?: RefObject<StoredItem[] | undefined>;
  /** What to read on the card on screen, and the lock screen's title and artist for it. Read as each card starts. */
  readCard: () => { texts: string[]; title: string; artist: string };
  /** A fully heard round of the sentence under review (sentence review only). */
  onRoundListened?: () => void;
  /** Hears auto-play pause and resume, and false when it stops: the countdown stands still and the button shows it. */
  onPausedChange?: (paused: boolean) => void;
  /** Registers what the Duration timer's end does while the reading runs (useAutoPlay's setTimerExpiry). */
  setTimerExpiry?: (onExpired: (() => void) | null) => void;
  /** After a pause, takes the screen lock and the silent keep-alive again (useAutoPlay's rearmAutoPlay). */
  rearm?: () => void;
}

/** What the view does with sentence auto-play while it runs. */
export interface AutoPlayReaderControls {
  /** Pause or resume, from any point: mid-read, while a sentence loads, or between reads. */
  togglePause: () => void;
  pause: () => void;
  resume: () => void;
  /** Read the current sentence again from its start, in the speech style just chosen. */
  restartRead: () => void;
}

/**
 * Sentence auto-play's reading: it reads each card's sentences in turn, as many times as asked with the gap between
 * reads, then moves to the next card, until the last card or Stop (services/audio/autoplayController.ts, one per run).
 * Other speech (a lookup, a popup, a word) or a change of voice pauses sentence review's reading, and a resume reads
 * the cut-off sentence again; on word cards it ends the reading. While it runs it holds the audio session open and
 * drives the lock screen, which shows it playing through the gaps and paused while paused, so the installed app keeps
 * reading with the screen off and a headset's play/pause works between reads too.
 */
export function useAutoPlayReader({
  active, stop, repeatsRef, gapRef, groups, currentGroupIndex, currentItemIndex, setCurrentGroupIndex,
  setCurrentItemIndex, currentGroupIndexRef, currentItem, sentenceReview, sentenceItemsRef, readCard, onRoundListened,
  onPausedChange, setTimerExpiry, rearm,
}: AutoPlayReaderOptions): AutoPlayReaderControls {
  const controllerRef = useRef<AutoplayController | null>(null);
  const stopRef = useLatest(stop);
  const onRoundListenedRef = useLatest(onRoundListened);
  const onPausedChangeRef = useLatest(onPausedChange);
  const setTimerExpiryRef = useLatest(setTimerExpiry);
  const rearmRef = useLatest(rearm);

  // One controller per run of auto-play, which follows the engine's state (a pause it didn't ask for included).
  useEffect(() => {
    if (!active) return;
    const controller = createAutoplayController({
      mode: sentenceReview ? 'sentence-review' : 'word-cards',
      // Deliberate action → allow the one-time model download.
      speak: (text, { onEnd, onError, onInterrupted }) => speakNatural(text, { allowDownload: true, onEnd, onError, onInterrupted }),
      pauseClip: pauseCurrent,
      resumeClip: resumeCurrent,
      playbackStatus: () => getPlaybackState().status,
      afterGap,
      // Holds the engine through each gap, so speech then pauses (or ends) the reading as it would mid-read.
      reserve: reservePlayback,
      // Read as the reading goes, so a change applies from the next read.
      settings: () => ({ repeats: repeatsRef.current, gapMs: gapRef.current }),
      finish: () => stopRef.current(),
      roundListened: () => onRoundListenedRef.current?.(),
      rearm: () => rearmRef.current?.(),
    });
    controllerRef.current = controller;
    let paused = false;
    const reportPaused = (next: boolean) => {
      paused = next;
      onPausedChangeRef.current?.(next);
    };
    setPlaybackStateOverride('playing');
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getState().phase === 'paused';
      if (next === paused) return;
      setPlaybackStateOverride(next ? 'paused' : 'playing');
      reportPaused(next);
    });
    const unsubscribeEngine = subscribePlayback(state => controller.engineState(state.status));
    // The timer's end lets the read under way finish, then ends auto-play.
    const setExpiry = setTimerExpiryRef.current;
    setExpiry?.(() => controller.timerEnded());
    return () => {
      setExpiry?.(null);
      unsubscribeEngine();
      unsubscribe();
      controller.stop();
      controllerRef.current = null;
      setPlaybackStateOverride(null);
      if (paused) reportPaused(false);
    };
  }, [active, sentenceReview, repeatsRef, gapRef, stopRef, onRoundListenedRef, onPausedChangeRef, setTimerExpiryRef, rearmRef]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!active || !groups || !controller) return;
    const card = readCard();

    // Lock-screen "now playing" for this card/sentence (refreshed as autoplay advances).
    setMediaMetadata({
      title: card.title || 'DictProp',
      artist: card.artist,
      album: 'DictProp',
      artworkUrl: (() => { const u = getItemImageUrl(currentItem); return u && u.startsWith('data:image') ? u : undefined; })(),
    });

    const advanceCard = () => {
      const safeGroupIdx = Math.min(currentGroupIndex, groups.length - 1);
      const group = groups[safeGroupIdx];
      if (!group) { stopRef.current(); return; }
      const safeItemIdx = Math.min(currentItemIndex, group.items.length - 1);
      const isLastItem = safeItemIdx >= group.items.length - 1;
      const isLastGroup = safeGroupIdx >= groups.length - 1;
      if (!isLastItem) {
        setCurrentItemIndex(p => p + 1);
      } else if (!isLastGroup) {
        setCurrentGroupIndex(p => p + 1);
        setCurrentItemIndex(0);
      } else {
        stopRef.current(); // played the last card → stop
      }
    };

    // In sentence mode, read this card's saved sentence; otherwise read ALL of the card's example
    // sentences (both) in turn, then advance to the next card. A new card always reads, though the last one was paused.
    controller.startCard(card.texts, advanceCard);
    return () => controller.cancelCard();
    // The chain reads the card's text, title and picture when it starts, and restarts only when auto-play is
    // switched, the view moves or the cards change; a review or a refreshed copy mid-read doesn't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentGroupIndex, currentItemIndex, groups]);

  // Background sentence autoplay — while it runs, hold the audio session open (silent keep-alive) and
  // expose lock-screen controls so the installed PWA keeps reading sentences with the screen off.
  // next/prev just bump the index (the reading starts again there, paused or not); they don't stop autoplay.
  useEffect(() => {
    if (!active) return;
    acquireKeepAlive();
    const step = (delta: number) => {
      const len = sentenceReview ? (sentenceItemsRef?.current?.length ?? 0) : (groups?.length ?? 0);
      if (!len) return;
      const cur = currentGroupIndexRef.current;
      const nextIdx = Math.max(0, Math.min(cur + delta, len - 1));
      if (nextIdx === cur) return;
      setCurrentGroupIndex(nextIdx);
      setCurrentItemIndex(0);
    };
    setMediaSessionHandlers({
      onPlay: () => controllerRef.current?.resume(),
      onPause: () => controllerRef.current?.pause(),
      onStop: () => stop(),
      onNext: () => step(1),
      onPrev: () => step(-1),
    });
    return () => {
      setMediaSessionHandlers(null);
      releaseKeepAlive();
    };
    // The rest are refs, state setters and a flag fixed for the view's life, so this re-registers only when
    // auto-play is switched or the cards change.
  }, [active, groups, sentenceReview, sentenceItemsRef, currentGroupIndexRef, stop, setCurrentGroupIndex, setCurrentItemIndex]);

  const togglePause = useCallback(() => controllerRef.current?.togglePause(), []);
  const pause = useCallback(() => controllerRef.current?.pause(), []);
  const resume = useCallback(() => controllerRef.current?.resume(), []);
  const restartRead = useCallback(() => controllerRef.current?.restartRead(), []);
  return useMemo(() => ({ togglePause, pause, resume, restartRead }), [togglePause, pause, resume, restartRead]);
}
