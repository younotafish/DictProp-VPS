import { isVocabItem, savedVocabKey, type StoredItem, type VocabCard } from '../types';
import { makeVocabStoredItem } from './items';

/**
 * Saving the new senses of an analysis, one rule for the Text Analyzer and batch import. A sense is a word with its
 * exact sense label (savedVocabKey), and each is saved once: not when the notebook already holds it, and not again
 * when an earlier word of the same run, or the same analysis, produced it.
 * Only screens and tools that load on demand import this module; keep it out of the app's first chunk.
 */

/** The senses the library holds: savedVocabKey of every word card that isn't deleted. */
export const savedSenseKeys = (items: readonly StoredItem[]): Set<string> => {
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.isDeleted && isVocabItem(item)) keys.add(savedVocabKey(item.data));
  }
  return keys;
};

/**
 * Saves each sense in `vocabs` that `seen` doesn't hold as a new card, and adds it to `seen`, so a later call in the
 * same run skips it too. Returns the senses it saved, in order.
 */
export const saveNewSenses = (
  vocabs: readonly VocabCard[],
  seen: Set<string>,
  save: (item: StoredItem) => void,
): VocabCard[] => {
  const saved: VocabCard[] = [];
  for (const vocab of vocabs) {
    const key = savedVocabKey(vocab);
    if (seen.has(key)) continue;
    seen.add(key);
    save(makeVocabStoredItem(vocab));
    saved.push(vocab);
  }
  return saved;
};
