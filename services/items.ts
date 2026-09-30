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

/**
 * True when two copies share their content object. Reviews and archiving replace only the wrapper,
 * so indexes built from content can skip those changes.
 */
export const sameItemContent = (a: StoredItem, b: StoredItem): boolean => a.data === b.data;

/**
 * `incoming` saved over `existing`, the saved copy of the same card: the incoming content and schedule under
 * the saved card's id. A fresh AI result carries no revision, so it builds on the saved copy's.
 */
export const saveOverExisting = (existing: StoredItem, incoming: StoredItem, now: number): StoredItem => {
  const id = existing.data.id;
  // A copy older than the saved one built its edit on what the server held back then, so it keeps that sync
  // record. Pushing it then meets the newer server copy as a conflict: the edit rebases onto it only if the
  // server's content hasn't changed since, and otherwise yields instead of overwriting it.
  const staleCopy = incoming.serverRevision !== undefined && (existing.serverRevision ?? 0) > incoming.serverRevision;
  // Saving a deleted card again brings its learning history back: whoever saves it can't see that history
  // and sends a new schedule. Archiving isn't restored, since saving asks to study the card.
  const srs = existing.isDeleted && existing.srs ? existing.srs : incoming.srs || existing.srs;
  return {
    ...incoming,
    data: { ...incoming.data, id },
    savedAt: existing.savedAt || now,
    updatedAt: now,
    srs: { ...SRSAlgorithm.ensure(srs, id, existing.type), id },
    serverRevision: incoming.serverRevision ?? existing.serverRevision,
    lastSyncedHash: staleCopy ? incoming.lastSyncedHash : existing.lastSyncedHash,
  };
};
