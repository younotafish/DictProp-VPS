import { getItemSpelling, savedVocabKey, type SentenceData, type StoredItem, type VocabCard } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';

/**
 * The StoredItem wrapper for a freshly saved vocab sense: a new schedule and a save timestamp. Every "save this
 * word" path (Notebook, GlobalSearch, TextAnalyzer) builds it here, so the wrapper can't drift between them.
 */
export const makeVocabStoredItem = (vocab: VocabCard): StoredItem => ({
  data: vocab,
  type: 'vocab',
  savedAt: Date.now(),
  srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
});

/**
 * The StoredItem wrapper for a newly saved sentence: a fresh id, the sentence and the word (and sense) it came from,
 * a new schedule and a save timestamp. From `prepared`, the sentence as the screen holds it (a catalog line, or one
 * with an analysis or a picture), it takes the speech style, the catalog fields, the analysis and its time, and the
 * picture, each only when truthy, and never its id, text or schedule.
 */
export const makeSentenceStoredItem = (
  text: string,
  sourceWord: string,
  sourceSense?: string,
  prepared?: SentenceData,
): StoredItem => {
  const sentenceData: SentenceData = {
    id: crypto.randomUUID(),
    text,
    sourceWord,
    sourceSense,
    ...(prepared?.preferredSpeechStyle ? { preferredSpeechStyle: prepared.preferredSpeechStyle } : {}),
    ...(prepared?.catalogSentenceId ? { catalogSentenceId: prepared.catalogSentenceId } : {}),
    ...(prepared?.catalogCollectionId ? { catalogCollectionId: prepared.catalogCollectionId } : {}),
    ...(prepared?.catalogKind ? { catalogKind: prepared.catalogKind } : {}),
    ...(prepared?.catalogTitle ? { catalogTitle: prepared.catalogTitle } : {}),
    ...(prepared?.analysis ? { analysis: prepared.analysis } : {}),
    ...(prepared?.analysisGeneratedAt ? { analysisGeneratedAt: prepared.analysisGeneratedAt } : {}),
    ...(prepared?.imageUrl ? { imageUrl: prepared.imageUrl } : {}),
  };
  return {
    data: sentenceData,
    type: 'sentence',
    savedAt: Date.now(),
    srs: SRSAlgorithm.createNew(sentenceData.id, 'sentence'),
  };
};

/** What findSavedCopy looks a saved copy up by: the card on screen, a search result or a card being saved. */
export type SavedCopyProbe = Pick<StoredItem, 'type' | 'data'>;

/**
 * Where `probe`'s saved copy is in `items`, or -1: the item with its id, else the first of its type with the same
 * spelling (ignoring case and surrounding space) and, for a word, the exact same sense label (savedVocabKey, where a
 * missing sense is the empty one), so each meaning of a word keeps its own card. Deleted items count too: callers
 * pass the list they mean.
 */
export const findSavedCopyIndex = (items: readonly StoredItem[], probe: SavedCopyProbe): number => {
  const byId = items.findIndex(item => item.data.id === probe.data.id);
  if (byId >= 0) return byId;
  if (probe.type === 'vocab') {
    const key = savedVocabKey(probe.data as VocabCard);
    return items.findIndex(item => item.type === 'vocab' && savedVocabKey(item.data as VocabCard) === key);
  }
  // getItemSpelling reads nothing of an item but its type and data.
  const spelling = getItemSpelling(probe as StoredItem);
  return items.findIndex(item => item.type === probe.type && getItemSpelling(item) === spelling);
};

/** `probe`'s saved copy in `items` (see findSavedCopyIndex), or undefined. */
export const findSavedCopy = (items: readonly StoredItem[], probe: SavedCopyProbe): StoredItem | undefined => {
  const index = findSavedCopyIndex(items, probe);
  return index < 0 ? undefined : items[index];
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
