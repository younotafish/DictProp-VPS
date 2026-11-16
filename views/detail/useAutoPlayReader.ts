import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { getItemImageUrl, type ItemGroup, type StoredItem } from '../../types';
import {
  acquireKeepAlive, afterGap, getPlaybackState, pauseCurrent, releaseKeepAlive, resumeCurrent, setMediaMetadata,
  setMediaSessionHandlers, speakNatural, type SpeakHandle,
} from '../../services/neuralTts';

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
}

/**
 * Sentence auto-play's reading: it reads each card's sentences in turn, as many times as asked with the gap
 * between reads, then moves to the next card, until the last card or Stop. While it runs it holds the audio
 * session open and drives the lock screen, so the installed app keeps reading with the screen off; the lock
 * screen's pause holds the chain even between reads.
 */
export function useAutoPlayReader({
  active, stop, repeatsRef, gapRef, groups, currentGroupIndex, currentItemIndex, setCurrentGroupIndex,
  setCurrentItemIndex, currentGroupIndexRef, currentItem, sentenceReview, sentenceItemsRef, readCard, onRoundListened,
}: AutoPlayReaderOptions) {
  // Autoplay pause/resume across the inter-read GAP (not just mid-clip): the media-session /
  // Bluetooth pause must stop autoplay even between reads. autoPlayPausedRef gates the gap
  // scheduler; when paused mid-gap the pending continuation is stashed in resumeChainRef and
  // replayed on resume; cancelGapRef holds the live gap canceller so pause can abort it.
  const autoPlayPausedRef = useRef(false);
  const resumeChainRef = useRef<(() => void) | null>(null);
  const cancelGapRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active || !groups) return;
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
      if (!group) { stop(); return; }
      const safeItemIdx = Math.min(currentItemIndex, group.items.length - 1);
      const isLastItem = safeItemIdx >= group.items.length - 1;
      const isLastGroup = safeGroupIdx >= groups.length - 1;
      if (!isLastItem) {
        setCurrentItemIndex(p => p + 1);
      } else if (!isLastGroup) {
        setCurrentGroupIndex(p => p + 1);
        setCurrentItemIndex(0);
      } else {
        stop(); // played the last card → stop
      }
    };

    // In sentence mode, read this card's saved sentence; otherwise read ALL of the card's example
    // sentences (both) in turn, then advance to the next card.
    const sentences = card.texts;
    let cancelGap: (() => void) | undefined; // background-safe inter-read gap (afterGap) — see neuralTts
    let handle: SpeakHandle | undefined;
    let idx = 0;
    let rep = 0;
    let successfulReads = 0;

    // A fresh run (autoplay start or a next/prev navigation) always plays; only an explicit pause holds it.
    autoPlayPausedRef.current = false;
    resumeChainRef.current = null;
    cancelGapRef.current = null;

    // Schedule the next step after `ms`. When autoplay is paused (media-session / Bluetooth), the
    // continuation is stashed in resumeChainRef instead of arming the timer, so resume picks up exactly
    // where it left off; the live canceller is mirrored to cancelGapRef so onPause can abort a running
    // gap even BETWEEN reads (not just mid-clip). See the media-session effect below.
    const schedule = (ms: number, fn: () => void) => {
      resumeChainRef.current = fn; // remembered in case we pause during this gap
      if (autoPlayPausedRef.current) { cancelGapRef.current = null; return; }
      const run = () => { cancelGapRef.current = null; resumeChainRef.current = null; fn(); };
      cancelGap = afterGap(ms, run);
      cancelGapRef.current = cancelGap;
    };

    // Deliberate action → allow the one-time model download. Each sentence is read `sentenceRepeats`
    // times (total); the configurable gap sits between EVERY read — both repeats of the same sentence
    // and distinct sentences. Advancing to the NEXT card in item mode uses a short beat instead. (In
    // sentence mode each card is a single saved sentence, so the configurable gap applies across cards.)
    const CARD_GAP = 600; // short beat between cards in item mode
    const playNext = () => {
      if (idx >= sentences.length) { schedule(CARD_GAP, advanceCard); return; }
      const s = sentences[idx];
      const afterEach = () => {
        if (++rep < repeatsRef.current) { schedule(gapRef.current, playNext); return; } // read again
        rep = 0;
        successfulReads = 0;
        idx++;
        const more = idx < sentences.length;
        const gap = (more || sentenceReview) ? gapRef.current : CARD_GAP;
        schedule(gap, more ? playNext : advanceCard);
      };
      const afterSuccessfulRead = () => {
        successfulReads++;
        const completesSuccessfulRound = rep + 1 >= repeatsRef.current &&
          successfulReads >= repeatsRef.current;
        if (sentenceReview && completesSuccessfulRound) onRoundListened?.();
        afterEach();
      };
      handle = speakNatural(s, { allowDownload: true, onEnd: afterSuccessfulRead, onError: afterEach });
    };

    if (!sentences.length) {
      schedule(400, advanceCard); // card has no example → move on quickly
    } else {
      playNext();
    }

    return () => {
      handle?.stop();
      cancelGap?.();
      cancelGapRef.current = null;
      resumeChainRef.current = null;
    };
    // The chain reads the card's text, title and picture when it starts, and restarts only when auto-play is
    // switched, the view moves or the cards change; a review or a refreshed copy mid-read doesn't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentGroupIndex, currentItemIndex, groups]);

  // Background sentence autoplay — while it runs, hold the audio session open (silent keep-alive) and
  // expose lock-screen controls so the installed PWA keeps reading sentences with the screen off.
  // next/prev just bump the index (the autoplay effect re-runs and continues); they don't stop autoplay.
  useEffect(() => {
    if (!active) return;
    acquireKeepAlive();
    const step = (delta: number) => {
      const len = sentenceReview ? (sentenceItemsRef?.current?.length ?? 0) : (groups?.length ?? 0);
      if (!len) return;
      const cur = currentGroupIndexRef.current;
      const nextIdx = Math.max(0, Math.min(cur + delta, len - 1));
      if (nextIdx === cur) return;
      autoPlayPausedRef.current = false;   // a next/prev while paused resumes playback at the new sentence
      resumeChainRef.current = null;
      setCurrentGroupIndex(nextIdx);
      setCurrentItemIndex(0);
    };
    setMediaSessionHandlers({
      onPlay: () => {
        autoPlayPausedRef.current = false;
        if (getPlaybackState().status === 'paused') { resumeCurrent(); return; } // resume a mid-clip pause
        const cont = resumeChainRef.current;                                     // resume a gap that was paused
        resumeChainRef.current = null;
        cont?.();
      },
      onPause: () => {
        autoPlayPausedRef.current = true;
        const st = getPlaybackState().status;
        if (st === 'playing' || st === 'loading') { pauseCurrent(); return; }    // pause the current read
        cancelGapRef.current?.();                                                // between reads → abort the pending gap
        cancelGapRef.current = null;
      },
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
}
