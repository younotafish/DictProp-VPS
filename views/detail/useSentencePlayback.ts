import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import {
  getPlaybackProgress, getPlaybackState, pauseCurrent, resumeCurrent, speakNatural, speakNaturalAt,
} from '../../services/neuralTts';
import { sentenceSpaceAction, toggleActionFor } from '../../services/audio/playbackToggle';
import { setTtsStyle } from '../../services/ttsSettings';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { readInTurnOrToggle } from './useExampleSpeech';
import type { AutoPlayReaderControls } from './useAutoPlayReader';

interface SentencePlaybackOptions {
  /** The sentence under review. */
  currentSentenceRef: RefObject<StoredItem | null>;
  sentenceItemsRef: RefObject<StoredItem[] | undefined>;
  currentGroupIndexRef: RefObject<number>;
  isSentenceAutoPlayingRef: RefObject<boolean>;
  /** End whichever auto-play runs. */
  stopAutoPlay: () => void;
  /** Start sentence auto-play (Space with nothing playing). */
  startAutoPlay: () => void;
  /** Sentence auto-play's controls, read as each tap or key arrives: the view sets its reader up after these readers. */
  autoPlayRef: RefObject<Pick<AutoPlayReaderControls, 'togglePause'> | null>;
  setCurrentGroupIndex: Dispatch<SetStateAction<number>>;
  setCurrentItemIndex: Dispatch<SetStateAction<number>>;
  /** The sentence on screen was heard to its end; the view decides whether that writes anything. */
  onListened: (sentence: StoredItem) => void;
}

/**
 * Sentence review's reading: the sentence from the top, from a chosen word, or after moving to another sentence.
 * All speech funnels through the shared playback state, so the speaker icons stay in sync and a second press
 * pauses, resumes or restarts what's playing. Sentence auto-play owns the audio chain while it runs: a tap on blank
 * space, E and Space then pause or resume auto-play itself (between reads and while a sentence loads too), and no
 * reader starts a clip over it. A read heard to its end is a listen, which onListened hears about while its sentence
 * is still the one on screen.
 */
export function useSentencePlayback({
  currentSentenceRef, sentenceItemsRef, currentGroupIndexRef, isSentenceAutoPlayingRef, stopAutoPlay, startAutoPlay,
  autoPlayRef, setCurrentGroupIndex, setCurrentItemIndex, onListened,
}: SentencePlaybackOptions) {
  // A finished read of `expectedSentenceId` (by default, whatever is on screen) is a listen of the sentence on
  // screen, unless the learner has moved on to another one since.
  const noteListened = useCallback((expectedSentenceId?: string) => {
    const sentence = currentSentenceRef.current;
    if (!sentence || (expectedSentenceId && sentence.data.id !== expectedSentenceId)) return;
    onListened(sentence);
  }, [onListened, currentSentenceRef]);

  // E: read the saved sentence. Press again to pause; once more to resume. During auto-play, pause or resume it.
  const readCurrentSentence = useCallback(() => {
    // Continuous sentence autoplay owns the audio chain until its explicit Stop control is used.
    if (isSentenceAutoPlayingRef.current) { autoPlayRef.current?.togglePause(); return; }
    const sentence = currentSentenceRef.current;
    if (!sentence) return;
    const sentenceId = sentence.data.id;
    const sentences = [stripSentenceMarkers((sentence.data as SentenceData).text)].filter(Boolean);
    if (!sentences.length) return;
    readInTurnOrToggle(sentences, stopAutoPlay, () => noteListened(sentenceId));
  }, [noteListened, currentSentenceRef, isSentenceAutoPlayingRef, autoPlayRef, stopAutoPlay]);

  // Speak the saved sentence from the top (shared by the swipe gestures and the arrow keys).
  const speakCurrentSentence = useCallback(() => {
    const s = currentSentenceRef.current;
    if (!s) return;
    const sentence = stripSentenceMarkers((s.data as SentenceData).text || '').trim();
    if (!sentence) return;
    if (isSentenceAutoPlayingRef.current) return;
    stopAutoPlay();
    speakNatural(sentence, {
      allowDownload: true,
      onEnd: () => noteListened(s.data.id),
    });
  }, [noteListened, currentSentenceRef, isSentenceAutoPlayingRef, stopAutoPlay]);

  // Tap the sentence on blank space: the speaker's rule (pause it if it's playing, resume if paused, from the top
  // once 85% of it has played, else start it). Routed through the shared playback state so it stays in sync with the
  // megaphone button — whoever started the audio, this controls it. During auto-play it pauses or resumes auto-play,
  // wherever its reading is.
  const toggleSentencePlayback = useCallback(() => {
    if (isSentenceAutoPlayingRef.current) { autoPlayRef.current?.togglePause(); return; }
    const s = currentSentenceRef.current;
    if (!s) return;
    const sentence = stripSentenceMarkers((s.data as SentenceData).text || '').trim();
    if (!sentence) return;
    switch (toggleActionFor(getPlaybackState(), sentence, getPlaybackProgress(), { onLoading: 'ignore', restartNearEnd: true })) {
      case 'ignore': case 'cancel': return; // already starting this one
      case 'pause': pauseCurrent(); return;
      case 'resume': resumeCurrent(); return;
      case 'restart': case 'start': break;
    }
    stopAutoPlay();
    speakNatural(sentence, {
      allowDownload: true,
      onEnd: () => noteListened(s.data.id),
    });
  }, [noteListened, currentSentenceRef, isSentenceAutoPlayingRef, autoPlayRef, stopAutoPlay]);

  // Space: during auto-play, pause or resume it; otherwise pause or resume what's playing, wait for a sentence still
  // loading, and with nothing playing start auto-play.
  const handleSpace = useCallback(() => {
    const autoPlay = isSentenceAutoPlayingRef.current ? 'running' : 'off';
    switch (sentenceSpaceAction({ autoPlay, status: getPlaybackState().status })) {
      case 'toggle-autoplay-pause': autoPlayRef.current?.togglePause(); return;
      case 'pause': pauseCurrent(); return;
      case 'resume': resumeCurrent(); return;
      case 'ignore': return;
      case 'start-autoplay': startAutoPlay(); return;
    }
  }, [isSentenceAutoPlayingRef, autoPlayRef, startAutoPlay]);

  // Play the current sentence from a tapped or selected word (its character offset in the sentence as shown), in the
  // sentence's own voice, inside the tap. The speakers show the whole sentence; a clip of it already playing moves to
  // the word in place, else its clip starts there once its timings arrive within 400 ms, else the rest of the sentence
  // is read without starting the Kokoro download (services/neuralTts.ts speakNaturalAt). Auto-play owns the audio while
  // it runs, so then the tap only moves its clip.
  const playFromWordOffset = useCallback((offset: number) => {
    const s = currentSentenceRef.current;
    if (!s) return;
    const text = (s.data as SentenceData).text || '';
    if (!stripSentenceMarkers(text).trim()) return;
    const autoPlaying = !!isSentenceAutoPlayingRef.current;
    if (!autoPlaying) stopAutoPlay();
    speakNaturalAt(text, offset, { seekOnly: autoPlaying, onEnd: () => noteListened(s.data.id) });
  }, [noteListened, currentSentenceRef, isSentenceAutoPlayingRef, stopAutoPlay]);

  // Enter: play from the word the caret/selection sits in. No-op if not in a word, so it never hijacks
  // Enter elsewhere. Words carry data-word-offset (see HighlightedSentence).
  const handleEnterFromSelection = useCallback(() => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    const node: Node | null = sel?.anchorNode ?? null;
    let el: HTMLElement | null = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
    while (el && !(el.hasAttribute && el.hasAttribute('data-word-offset'))) el = el.parentElement;
    if (!el) return;
    const off = Number(el.getAttribute('data-word-offset'));
    if (Number.isFinite(off)) playFromWordOffset(off);
  }, [playFromWordOffset]);

  // Switch to another sentence and speak it at once (outside auto-play, which restarts itself there).
  const goToSentence = useCallback((nextIndex: number) => {
    const list = sentenceItemsRef.current ?? [];
    if (list.length === 0) return;
    const clamped = Math.max(0, Math.min(nextIndex, list.length - 1));
    const keepAutoPlaying = isSentenceAutoPlayingRef.current;
    if (clamped === currentGroupIndexRef.current) {
      if (!keepAutoPlaying) speakCurrentSentence(); // already at an end → re-speak outside autoplay
      return;
    }
    setCurrentGroupIndex(clamped);
    setCurrentItemIndex(0);
    const next = list[clamped];
    const sentence = next ? stripSentenceMarkers((next.data as SentenceData).text || '').trim() : '';
    const nextSpeechStyle = next ? (next.data as SentenceData).preferredSpeechStyle : undefined;
    // During auto-play the view's per-sentence style effect sets the voice, after the reading has let go of the last
    // sentence; a change of voice now would cut that read off as an interruption and show auto-play paused.
    if (nextSpeechStyle && !keepAutoPlaying) setTtsStyle(nextSpeechStyle);
    // The autoplay effect restarts itself at the selected sentence after the index changes. Starting a
    // separate manual clip here would supersede that chain and pause auto-play.
    if (!keepAutoPlaying && sentence && next) {
      speakNatural(sentence, {
        allowDownload: true,
        onEnd: () => noteListened(next.data.id),
      });
    }
  }, [
    noteListened, speakCurrentSentence, sentenceItemsRef, isSentenceAutoPlayingRef, currentGroupIndexRef,
    setCurrentGroupIndex, setCurrentItemIndex,
  ]);

  return {
    noteListened, readCurrentSentence, toggleSentencePlayback, handleSpace, playFromWordOffset, handleEnterFromSelection,
    goToSentence,
  };
}
