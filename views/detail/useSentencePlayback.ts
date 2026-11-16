import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import { getPlaybackState, getTimingsFor, pauseCurrent, resumeCurrent, seekCurrent, speakNatural } from '../../services/neuralTts';
import { alignWordsToStripped, seekTimeForOffset } from '../../services/ttsAlignment';
import { getTtsStyle, setTtsStyle } from '../../services/ttsSettings';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { SENTENCE_PREVIEW_ID_PREFIX } from './sentenceUnderReview';
import { readInTurnOrToggle } from './useExampleSpeech';

interface SentencePlaybackOptions {
  /** The sentence under review; a listen writes the updated copy back so the next one builds on it. */
  currentSentenceRef: RefObject<StoredItem | null>;
  sentenceItemsRef: RefObject<StoredItem[] | undefined>;
  currentGroupIndexRef: RefObject<number>;
  isSentenceAutoPlayingRef: RefObject<boolean>;
  /** End whichever auto-play runs. */
  stopAutoPlay: () => void;
  setCurrentGroupIndex: Dispatch<SetStateAction<number>>;
  setCurrentItemIndex: Dispatch<SetStateAction<number>>;
  onSave: (item: StoredItem) => void;
}

/**
 * Sentence review's reading: the sentence from the top, from a chosen word, or after moving to another sentence.
 * All speech funnels through the shared playback state, so the speaker icons stay in sync and a second press
 * pauses, resumes or restarts what's playing. Sentence auto-play owns the audio chain while it runs: these
 * readers may pause or resume its clip, but never start one over it. A fully heard read counts as a listen.
 */
export function useSentencePlayback({
  currentSentenceRef, sentenceItemsRef, currentGroupIndexRef, isSentenceAutoPlayingRef, stopAutoPlay,
  setCurrentGroupIndex, setCurrentItemIndex, onSave,
}: SentencePlaybackOptions) {
  const recordSentenceExposure = useCallback((expectedSentenceId?: string) => {
    const sentence = currentSentenceRef.current;
    if (!sentence || (expectedSentenceId && sentence.data.id !== expectedSentenceId)) return;
    const sentenceData = sentence.data as SentenceData;
    // Listening to an unsaved word-card preview must not silently save it. Catalog previews already
    // have stable progress identities and are intentionally persisted like ordinary saved sentences.
    if (sentence.data.id.startsWith(SENTENCE_PREVIEW_ID_PREFIX) && !sentenceData.catalogSentenceId) return;
    const now = Date.now();
    const speechStyle = getTtsStyle();
    const updated: StoredItem = {
      ...sentence,
      data: sentenceData.preferredSpeechStyle === speechStyle
        ? sentenceData
        : { ...sentenceData, preferredSpeechStyle: speechStyle },
      srs: SRSAlgorithm.updateAfterExposure(sentence.srs, now),
      updatedAt: now,
    };
    currentSentenceRef.current = updated;
    onSave(updated);
  }, [onSave, currentSentenceRef]);

  // E: read the saved sentence. Press again to pause; once more to resume.
  const readCurrentSentence = useCallback(() => {
    const sentence = currentSentenceRef.current;
    if (!sentence) return;
    const exposureSentenceId = sentence.data.id;
    const sentences = [stripSentenceMarkers((sentence.data as SentenceData).text)].filter(Boolean);
    if (!sentences.length) return;

    // Continuous sentence autoplay owns the audio chain until its explicit Stop control is used.
    // Keyboard/manual read commands may pause or resume its current clip, but never replace the chain.
    if (isSentenceAutoPlayingRef.current) {
      const status = getPlaybackState().status;
      if (status === 'playing') pauseCurrent();
      else if (status === 'paused') resumeCurrent();
      return;
    }

    readInTurnOrToggle(sentences, stopAutoPlay, () => recordSentenceExposure(exposureSentenceId));
  }, [recordSentenceExposure, currentSentenceRef, isSentenceAutoPlayingRef, stopAutoPlay]);

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
      onEnd: () => recordSentenceExposure(s.data.id),
    });
  }, [recordSentenceExposure, currentSentenceRef, isSentenceAutoPlayingRef, stopAutoPlay]);

  // Tap the sentence (or context-aware Space): pause it if it's playing, resume if paused, otherwise
  // (re)start it from the top. Routed through the shared playback state so it stays in sync with the
  // megaphone button — whoever started the audio, this controls it.
  const toggleSentencePlayback = useCallback(() => {
    const s = currentSentenceRef.current;
    if (!s) return;
    const sentence = stripSentenceMarkers((s.data as SentenceData).text || '').trim();
    if (!sentence) return;
    const pb = getPlaybackState();
    if (pb.text === sentence) {
      if (pb.status === 'loading') return;                       // already starting this one
      if (pb.status === 'playing') { pauseCurrent(); return; }
      if (pb.status === 'paused') { resumeCurrent(); return; }
    }
    if (isSentenceAutoPlayingRef.current) return;
    stopAutoPlay();
    speakNatural(sentence, {
      allowDownload: true,
      onEnd: () => recordSentenceExposure(s.data.id),
    });
  }, [recordSentenceExposure, currentSentenceRef, isSentenceAutoPlayingRef, stopAutoPlay]);

  // Play the current sentence starting at a clicked/selected word (by its char offset in the stripped
  // sentence). If this sentence's clip is already the active audio, seek it in place (seamless);
  // otherwise (re)start the sentence and seek once it's playing. Falls back to reading the remainder
  // when no word timings are available (legacy clip / in-browser / system voice).
  const playFromWordOffset = useCallback(async (offset: number) => {
    const s = currentSentenceRef.current;
    if (!s) return;
    const stripped = stripSentenceMarkers((s.data as SentenceData).text || '').trim();
    if (!stripped) return;
    // Resolve timings up-front (instant if warmed on mount, else a quick fetch) and compute the start
    // time BEFORE playing — avoids the start-from-zero-then-late-seek race.
    const timings = await getTimingsFor(stripped);
    const startAt = timings ? seekTimeForOffset(alignWordsToStripped(stripped, timings), offset) : null;
    const pb = getPlaybackState();
    if (pb.text === stripped && (pb.status === 'playing' || pb.status === 'paused') && startAt != null) {
      seekCurrent(startAt); // already this sentence's clip → seek in place (seamless)
      if (pb.status === 'paused') resumeCurrent();
      return;
    }
    if (isSentenceAutoPlayingRef.current) return;
    stopAutoPlay();
    // Timings can be absent for a legacy/system-voice clip or during a flaky-network timeout. Reading
    // the remaining text is a prosody compromise, but it preserves the interaction's core promise:
    // Command-click starts audibly at the selected word rather than unexpectedly returning to word one.
    const fallbackRemainder = stripped.slice(Math.max(0, offset)).trimStart();
    const textToSpeak = startAt == null && fallbackRemainder ? fallbackRemainder : stripped;
    speakNatural(textToSpeak, {
      allowDownload: true,
      startAt: startAt ?? undefined,
      onEnd: () => recordSentenceExposure(s.data.id),
    }); // (re)start AT the word
  }, [recordSentenceExposure, currentSentenceRef, isSentenceAutoPlayingRef, stopAutoPlay]);

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
    if (nextSpeechStyle) setTtsStyle(nextSpeechStyle);
    // The autoplay effect restarts itself at the selected sentence after the index changes. Starting a
    // separate manual clip here would supersede that chain and leave autoplay visually on but stalled.
    if (!keepAutoPlaying && sentence && next) {
      speakNatural(sentence, {
        allowDownload: true,
        onEnd: () => recordSentenceExposure(next.data.id),
      });
    }
  }, [
    recordSentenceExposure, speakCurrentSentence, sentenceItemsRef, isSentenceAutoPlayingRef, currentGroupIndexRef,
    setCurrentGroupIndex, setCurrentItemIndex,
  ]);

  return {
    recordSentenceExposure, readCurrentSentence, toggleSentencePlayback, playFromWordOffset, handleEnterFromSelection,
    goToSentence,
  };
}
