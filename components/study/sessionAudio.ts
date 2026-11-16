import type { PlaybackState, SpeakHandle, SpeakOptions } from '../../services/neuralTts';
import { toggleActionFor } from '../../services/audio/playbackToggle';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';

/** The speech calls a study session's audio goes through: services/neuralTts's, or a test's. */
export interface SessionAudioEngine {
  speakNatural: (text: string, options?: SpeakOptions) => SpeakHandle;
  speakWord: (text: string) => SpeakHandle;
  getPlaybackState: () => PlaybackState;
  getPlaybackProgress: () => number;
  pauseCurrent: () => void;
  resumeCurrent: () => void;
  /** Fetches the clips the server already has into the device's cache; never asks for one to be made. */
  prefetchTTS: (texts: readonly string[]) => void;
}

/** The audio a study session starts, kept apart from audio it didn't. */
export interface SessionAudio {
  /** Plays a listening card's prompt as the card appears. A miss never starts the Kokoro download: nobody asked yet. */
  playPrompt: (text: string) => void;
  /** Plays the prompt again from its start, for E before the answer shows; a miss may start the download. */
  replayPrompt: (text: string) => void;
  /** Says the word (P once the answer shows). */
  sayWord: (word: string) => void;
  /** Says the word as the answer shows, unless a sentence is playing or about to, which it would cut off. */
  sayWordOnReveal: (word: string) => void;
  /** E once the answer shows: pauses, resumes or starts the example as every play control does (toggleActionFor). */
  toggleSentence: (text: string) => void;
  /** Stops what the session started, if it still plays. Audio the session didn't start is never stopped. */
  stopAll: () => void;
  /** Fetches the clips of prompts the session will play, so they start at once. Nothing is generated. */
  prefetch: (texts: readonly string[]) => void;
}

/**
 * A study session's audio. It keeps the handle of everything it starts until stopAll, and each handle stops only its
 * own playback (services/neuralTts's SpeakHandle), so grading, ending or undoing stops the session's audio and never
 * a sentence something else started. The engine is passed in, so the tests run it without a browser.
 */
export function createSessionAudio(engine: SessionAudioEngine): SessionAudio {
  // Everything started since the last stopAll. The engine has one voice, so only the newest can still be playing and
  // stopping the others does nothing; but a speak that started nothing (an empty text) never hides one that did.
  let started: SpeakHandle[] = [];
  const keep = (handle: SpeakHandle) => { started.push(handle); };
  const say = (word: string) => {
    if (word.trim()) keep(engine.speakWord(word));
  };
  return {
    playPrompt: text => keep(engine.speakNatural(text, { allowDownload: false })),
    replayPrompt: text => keep(engine.speakNatural(text, { allowDownload: true })),
    sayWord: say,
    sayWordOnReveal: word => {
      const { status } = engine.getPlaybackState();
      if (status !== 'playing' && status !== 'loading') say(word);
    },
    toggleSentence: text => {
      const sentence = stripSentenceMarkers(text).trim();
      if (!sentence) return;
      switch (toggleActionFor(engine.getPlaybackState(), sentence, engine.getPlaybackProgress(), { onLoading: 'ignore', restartNearEnd: true })) {
        case 'ignore': case 'cancel': return; // still loading: let it start
        case 'pause': engine.pauseCurrent(); return;
        case 'resume': engine.resumeCurrent(); return;
        case 'restart': case 'start': keep(engine.speakNatural(sentence, { allowDownload: true }));
      }
    },
    stopAll: () => {
      const handles = started;
      started = [];
      for (const handle of handles) handle.stop();
    },
    prefetch: texts => {
      if (texts.length > 0) engine.prefetchTTS(texts);
    },
  };
}
