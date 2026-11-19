import type { SpeakHandle, SpeakOptions } from '../../services/neuralTts';
import type { WarmEntry } from '../../services/audio/clipWarmers';
import type { TtsStyle } from '../../services/ttsSettings';

/** The speech calls Today's audio goes through: services/neuralTts's and services/ttsSettings's, or a test's. */
export interface LoopAudioEngine {
  speakNatural: (text: string, options?: SpeakOptions) => SpeakHandle;
  /** Fetches the clips the server already has into the device's cache; never asks for one to be made. */
  prefetchTTS: (entries: readonly WarmEntry[]) => void;
  getTtsStyle: () => TtsStyle;
  setTtsStyle: (style: TtsStyle) => void;
}

/** What an answer says aloud: the sentence's clip, in the voice it was last heard in. */
export interface LoopSpeech {
  text: string;
  style?: TtsStyle;
}

/** The audio a Today session starts, kept apart from audio it didn't. */
export interface LoopAudio {
  /** Says the answer as it shows: called inside the reveal's tap or key press, since iOS lets the system voice (what
   *  reads a sentence without its clip) speak only from a gesture. A clip that isn't cached never starts the Kokoro
   *  download: nobody asked yet. */
  sayAnswer: (speech: LoopSpeech) => void;
  /** Says it again, for P or the replay button; a missing clip may start the download, as any asked-for play does. */
  replay: (speech: LoopSpeech) => void;
  /** Takes a read the card's own speaker started as the session's, so answering or leaving stops it too. */
  own: (handle: SpeakHandle) => void;
  /** Stops what the session started, if it still plays. Audio the session didn't start is never stopped. */
  stopAll: () => void;
  /** Fetches the clips of sentences the session shows next, each in its own voice, so they start at once. */
  prefetch: (speech: readonly LoopSpeech[]) => void;
}

/**
 * Today's audio, modelled on components/study/sessionAudio.ts: it keeps the handle of everything it starts until
 * stopAll, and each handle stops only its own playback, so answering, ending or undoing stops the session's audio and
 * never a sentence something else started. A sentence plays in its own voice (its preferredSpeechStyle, as the sentence
 * lesson plays it), switched before the read starts, never during one. The engine is passed in, so the tests run it
 * without a browser.
 */
export function createLoopAudio(engine: LoopAudioEngine): LoopAudio {
  let started: SpeakHandle[] = [];
  const keep = (handle: SpeakHandle) => { started.push(handle); };
  const speak = (speech: LoopSpeech, allowDownload: boolean) => {
    const text = speech.text.trim();
    if (!text) return;
    if (speech.style && speech.style !== engine.getTtsStyle()) engine.setTtsStyle(speech.style);
    keep(engine.speakNatural(text, { allowDownload }));
  };
  return {
    sayAnswer: speech => speak(speech, false),
    replay: speech => speak(speech, true),
    own: keep,
    stopAll: () => {
      const handles = started;
      started = [];
      for (const handle of handles) handle.stop();
    },
    prefetch: speech => {
      // A sentence with no voice of its own plays in the one the sentence before it left, as the lesson's preload has it.
      let style = engine.getTtsStyle();
      const entries: WarmEntry[] = [];
      for (const entry of speech) {
        const text = entry.text.trim();
        if (!text) continue;
        style = entry.style ?? style;
        entries.push({ text, style });
      }
      if (entries.length > 0) engine.prefetchTTS(entries);
    },
  };
}
