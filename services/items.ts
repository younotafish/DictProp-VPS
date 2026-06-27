import { StoredItem, VocabCard } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';

/**
 * Build the StoredItem wrapper for a freshly-saved vocab sense — a new SRS schedule, a save timestamp,
 * and the active project tag when one is set. Shared by every "save this word" path (Notebook,
 * GlobalSearch, TextAnalyzer) so the wrapper shape can't drift between them.
 */
export const makeVocabStoredItem = (vocab: VocabCard, activeProject?: string | null): StoredItem => ({
  data: vocab,
  type: 'vocab',
  savedAt: Date.now(),
  srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
  ...(activeProject ? { project: activeProject } : {}),
});
