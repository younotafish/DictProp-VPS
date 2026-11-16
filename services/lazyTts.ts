/**
 * Transitional: the speech engine is services/neuralTts.ts, and screens import it directly. views/detail/cardKeys.ts
 * still imports these names from here; once it imports them from services/neuralTts, delete this file.
 */
export { getPlaybackState, pauseCurrent, resumeCurrent, speakWord } from './neuralTts';
