import type { SpeakHandle, SpeakOptions } from '../../services/neuralTts';

/** The speech calls the sheet's audio goes through: services/neuralTts's, or a test's. */
export interface SheetAudioEngine {
  speakWord: (text: string) => SpeakHandle;
  speakNatural: (text: string, options?: SpeakOptions) => SpeakHandle;
}

/** The pause between two examples read in turn, as in the review popup. */
export const BETWEEN_EXAMPLES_MS = 400;

/** The audio the results sheet starts, kept apart from audio it didn't. */
export interface SheetAudio {
  /** Says a word. */
  word: (text: string) => void;
  /** Reads a sentence. */
  sentence: (text: string, options?: SpeakOptions) => void;
  /** Reads `sentences` one after another, a short pause between them, until something else speaks. */
  inTurn: (sentences: readonly string[]) => void;
  /**
   * Stops what the sheet started last, a run read in turn included, if nothing has spoken over it since. The engine
   * has one voice, so audio the sheet didn't start has superseded it and plays on.
   */
  stop: () => void;
}

/**
 * The sheet's audio. It keeps the handle of the last thing it said or read; each handle stops only its own playback
 * (see services/neuralTts's SpeakHandle), so closing the sheet or moving to another meaning stops the sheet's audio
 * and never a sentence the sheet didn't start.
 */
export function createSheetAudio(
  engine: SheetAudioEngine,
  schedule: (next: () => void, ms: number) => void = (next, ms) => { setTimeout(next, ms); },
): SheetAudio {
  let latest: SpeakHandle | null = null;
  // Each word, sentence, run or stop starts a new turn; a run read in turn goes on only while it's still the turn.
  let turn = 0;
  return {
    word: text => {
      turn++;
      latest = engine.speakWord(text);
    },
    sentence: (text, options) => {
      turn++;
      latest = engine.speakNatural(text, options);
    },
    inTurn: sentences => {
      const run = ++turn;
      let index = 0;
      const next = () => {
        // Over once the sheet has said or read something else, stopped, or been talked over.
        if (run !== turn || index >= sentences.length || (index > 0 && !latest?.isActive())) return;
        const after = () => schedule(next, BETWEEN_EXAMPLES_MS);
        latest = engine.speakNatural(sentences[index++], { allowDownload: true, onEnd: after, onError: after });
      };
      next();
    },
    stop: () => {
      turn++;
      latest?.stop();
      latest = null;
    },
  };
}
