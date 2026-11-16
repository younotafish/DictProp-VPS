import { useCallback, type RefObject } from 'react';
import type { StoredItem } from '../../types';
import { getPlaybackProgress, getPlaybackState, pauseCurrent, resumeCurrent, speakNatural, type SpeakHandle } from '../../services/neuralTts';
import { toggleActionFor } from '../../services/audio/playbackToggle';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { exampleAt, readableExamples } from './cardReading';

/**
 * Reads sentences one after another with a short breath between, or, when one of them is the clip already active,
 * follows the speaker's rule: pause it, resume it, leave it loading, or once 85% of it has played start the run again
 * from the first sentence. Other speech or a move to another card ends the run. `onRead` follows each finished read.
 */
export function readInTurnOrToggle(sentences: string[], stopAutoPlay: () => void, onRead?: () => void) {
  const pb = getPlaybackState();
  if (pb.text && sentences.includes(pb.text)) {
    switch (toggleActionFor(pb, pb.text, getPlaybackProgress(), { onLoading: 'ignore', restartNearEnd: true })) {
      case 'pause': pauseCurrent(); return;
      case 'resume': resumeCurrent(); return;
      case 'ignore': case 'cancel': return; // still loading
      case 'restart': case 'start': break; // nearly over: the run starts again from its first sentence
    }
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
  /** Ends whichever auto-play runs, as a manual read starts. */
  stopAutoPlay: () => void;
  /** Word cards: E during example auto-play pauses or resumes it instead of reading the card. */
  toggleAutoPlayPause?: () => void;
}

/**
 * Reading a card's example sentences on demand: E, the eyes-free zones and Cmd/Ctrl+1–4. Routed through the
 * shared playback state so the megaphone icons stay in sync: the same clip playing pauses, paused resumes, almost
 * done restarts from the top, and anything else starts fresh.
 */
export function useExampleSpeech({
  currentItemRef, isSentenceAutoPlayingRef, sentenceReview, stopAutoPlay, toggleAutoPlayPause,
}: ExampleSpeechOptions) {
  // E: read the displayed card's example sentences in turn. Press again to pause; once more to resume. During example
  // auto-play, pause or resume it, between reads too.
  const readCardExamples = useCallback(() => {
    if (toggleAutoPlayPause && isSentenceAutoPlayingRef.current) { toggleAutoPlayPause(); return; }
    const item = currentItemRef.current;
    if (!item) return;
    const sentences = readableExamples(item);
    if (!sentences.length) return;
    readInTurnOrToggle(sentences, stopAutoPlay);
  }, [currentItemRef, isSentenceAutoPlayingRef, stopAutoPlay, toggleAutoPlayPause]);

  const toggleSpeak = useCallback((raw: string) => {
    const sentence = stripSentenceMarkers(raw || '').trim();
    if (!sentence) return;
    switch (toggleActionFor(getPlaybackState(), sentence, getPlaybackProgress(), { onLoading: 'ignore', restartNearEnd: true })) {
      case 'ignore': case 'cancel': return; // already starting this very sentence
      case 'resume': resumeCurrent(); return;
      case 'pause': pauseCurrent(); return; // mid-clip; almost done restarts from the top instead
      case 'restart': case 'start': break;
    }
    if (sentenceReview && isSentenceAutoPlayingRef.current) return;
    stopAutoPlay();
    speakNatural(sentence, { allowDownload: true });
  }, [sentenceReview, isSentenceAutoPlayingRef, stopAutoPlay]);

  // Cmd/Ctrl+1–4: read the corresponding example sentence (a phrase has one: its query). A second
  // press on the same sentence pauses/resumes unless it is almost finished, when it restarts.
  const speakSentenceAt = useCallback((index: number) => {
    const item = currentItemRef.current;
    if (!item) return;
    toggleSpeak(exampleAt(item, index));
  }, [toggleSpeak, currentItemRef]);

  return { readCardExamples, toggleSpeak, speakSentenceAt };
}
