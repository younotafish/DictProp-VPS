import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { StoredItem } from '../../types';
import { getPlaybackProgress, getPlaybackState, pauseCurrent, resumeCurrent, speakNatural, type SpeakHandle } from '../../services/lazyTts';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { exampleAt, readableExamples } from './cardReading';

/** A second press once the clip is this far in restarts it, as the sentence speaker button does. */
const RESTART_NEAR_END = 0.85;

/**
 * Reads sentences one after another with a short breath between, or pauses and resumes them when one of them is
 * the clip already playing. Other speech or a move to another card ends the run. `onRead` follows each finished read.
 */
export function readInTurnOrToggle(sentences: string[], stopAutoPlay: () => void, onRead?: () => void) {
  // Already reading one of these → toggle pause / resume.
  const pb = getPlaybackState();
  if (pb.text && sentences.includes(pb.text) && (pb.status === 'playing' || pb.status === 'paused')) {
    if (pb.status === 'playing') pauseCurrent(); else resumeCurrent();
    return;
  }

  stopAutoPlay();
  let idx = 0;
  let handle: SpeakHandle | undefined;
  const playNext = () => {
    if (idx >= sentences.length) return;
    if (handle && !handle.isActive()) return; // superseded by other speech / navigation → stop the chain
    const s = sentences[idx++];
    handle = speakNatural(s, {
      allowDownload: true,
      onEnd: () => {
        onRead?.();
        setTimeout(playNext, 400);               // small breath between the two sentences
      },
      onError: () => setTimeout(playNext, 400),
    });
  };
  playNext();
}

interface ExampleSpeechOptions {
  /** The card on screen (in sentence review, the sentence's source card). */
  currentItemRef: RefObject<StoredItem | null>;
  isSentenceAutoPlayingRef: RefObject<boolean>;
  /** Sentence review's auto-play owns the audio chain, so these readers never start a clip over it. */
  sentenceReview: boolean;
  setIsAutoPlaying: Dispatch<SetStateAction<boolean>>;
  setIsSentenceAutoPlaying: Dispatch<SetStateAction<boolean>>;
}

/**
 * Reading a card's example sentences on demand: E, the eyes-free zones and Cmd/Ctrl+1–4. Routed through the
 * shared playback state so the megaphone icons stay in sync: the same clip playing pauses, paused resumes, almost
 * done restarts from the top, and anything else starts fresh.
 */
export function useExampleSpeech({ currentItemRef, isSentenceAutoPlayingRef, sentenceReview, setIsAutoPlaying, setIsSentenceAutoPlaying }: ExampleSpeechOptions) {
  // E: read the displayed card's example sentences in turn. Press again to pause; once more to resume.
  const readCardExamples = useCallback(() => {
    const item = currentItemRef.current;
    if (!item) return;
    const sentences = readableExamples(item);
    if (!sentences.length) return;
    readInTurnOrToggle(sentences, () => {
      setIsAutoPlaying(false);
      setIsSentenceAutoPlaying(false);
    });
  }, [currentItemRef, setIsAutoPlaying, setIsSentenceAutoPlaying]);

  const toggleSpeak = useCallback((raw: string) => {
    const sentence = stripSentenceMarkers(raw || '').trim();
    if (!sentence) return;
    const pb = getPlaybackState();
    if (pb.text === sentence) {
      if (pb.status === 'loading') return;                          // already starting this very sentence
      if (pb.status === 'paused') { resumeCurrent(); return; }
      // Mid-clip → pause; almost done → fall through and restart from the top.
      if (pb.status === 'playing' && getPlaybackProgress() < RESTART_NEAR_END) { pauseCurrent(); return; }
    }
    if (sentenceReview && isSentenceAutoPlayingRef.current) return;
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    speakNatural(sentence, { allowDownload: true });
  }, [sentenceReview, isSentenceAutoPlayingRef, setIsAutoPlaying, setIsSentenceAutoPlaying]);

  // Cmd/Ctrl+1–4: read the corresponding example sentence (a phrase has one: its query). A second
  // press on the same sentence pauses/resumes unless it is almost finished, when it restarts.
  const speakSentenceAt = useCallback((index: number) => {
    const item = currentItemRef.current;
    if (!item) return;
    toggleSpeak(exampleAt(item, index));
  }, [toggleSpeak, currentItemRef]);

  return { readCardExamples, toggleSpeak, speakSentenceAt };
}
