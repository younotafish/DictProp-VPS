import type { SentenceData, StoredItem } from '../../types';
import type { TtsStyle } from '../../services/ttsSettings';

/**
 * The sentence to save once it has been heard, or chosen, in the `style` voice (Clear or Casual): a copy that
 * remembers the voice, stamped `now`, or null when it already does, so nothing is written or pushed. Its progress
 * (srs) is the same object: hearing a sentence isn't a review. A catalog line that has no record yet has no voice
 * either, so its first listen still gives it one.
 */
export function withSpeechStyle(sentence: StoredItem, style: TtsStyle, now: number): StoredItem | null {
  const data = sentence.data as SentenceData;
  if (data.preferredSpeechStyle === style) return null;
  return { ...sentence, data: { ...data, preferredSpeechStyle: style }, updatedAt: now };
}
