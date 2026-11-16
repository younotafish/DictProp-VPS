import type { SpeakHandle } from '../../services/neuralTts';

/**
 * The read a list's rows last started, kept by the list rather than by the row: a virtual list unmounts a row that
 * scrolls out of view, and the sentence it started goes on until the list itself closes. A handle stops only the read
 * it started (services/neuralTts), so stopping one that a newer read has superseded changes nothing.
 */
export interface SpeechSlot {
  /** Keeps the handle of a read a row just started, in place of the one before. */
  remember: (handle: SpeakHandle) => void;
  /** Stops the kept read, if it still plays, and forgets it. */
  stop: () => void;
}

export function createSpeechSlot(): SpeechSlot {
  let kept: SpeakHandle | null = null;
  return {
    remember: handle => { kept = handle; },
    stop: () => {
      const handle = kept;
      kept = null;
      handle?.stop();
    },
  };
}
