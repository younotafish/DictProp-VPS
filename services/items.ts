import { StoredItem, VocabCard, isVocabItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';

/**
 * Build the StoredItem wrapper for a freshly-saved vocab sense — a new SRS schedule, a save timestamp,
 * Shared by every "save this word" path (Notebook, GlobalSearch, TextAnalyzer) so the wrapper
 * shape cannot drift between them.
 */
export const makeVocabStoredItem = (vocab: VocabCard): StoredItem => ({
  data: vocab,
  type: 'vocab',
  savedAt: Date.now(),
  srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
});

/**
 * Merge an illustration that finished after a save into the canonical stored card.
 * The AI result has a temporary id, so word+sense is the fallback identity. Learning
 * state and the saved id always remain owned by the existing item.
 */
export const mergeGeneratedVocabIntoStoredItem = (
  items: readonly StoredItem[],
  vocab: VocabCard,
): StoredItem | null => {
  if (!vocab.imageUrl) return null;
  const word = vocab.word.toLowerCase().trim();
  const sense = vocab.sense || '';
  const existing = items.find(item =>
    isVocabItem(item) && !item.isDeleted && (
      item.data.id === vocab.id ||
      (item.data.word.toLowerCase().trim() === word && (item.data.sense || '') === sense)
    ),
  );
  if (!existing || !isVocabItem(existing)) return null;

  return {
    ...existing,
    data: { ...existing.data, imageUrl: vocab.imageUrl, id: existing.data.id },
    srs: existing.srs,
    savedAt: existing.savedAt,
  };
};
