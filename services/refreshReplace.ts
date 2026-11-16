import { getItemSpelling, isVocabItem, type StoredItem, type VocabCard } from '../types';
import { makeVocabStoredItem } from './items';

// Refresh with AI on a saved word: a real re-run of the AI replaces the word's saved cards with the fresh result.
// useLibraryActions.handleRefreshReplace loads this with import() when a refresh lands, tens of seconds after it
// was asked for, so none of it is in the first chunk.

/** The copies a refresh saves, which handleRefreshReplace hands to handleSave. */
export interface RefreshReplacePlan {
  /**
   * A saved card updated in place for each fresh sense it has: the fresh content under the saved card's id, with
   * its schedule and save time, so spaced-repetition progress survives the refresh.
   */
  updates: StoredItem[];
  /** A new card for each fresh sense none of the word's saved cards has. */
  created: StoredItem[];
}

/**
 * What saving a fresh AI result `vocabs` for the saved word `word` saves. The word's cards are its live vocab cards
 * of the same spelling, ignoring case and surrounding space; a fresh sense updates the one with the exact same sense
 * label (a missing label is the empty one), and any other becomes a new card. The cards the result leaves out stay:
 * the model's sense coverage varies between calls, so an omission is no evidence that a stored meaning should go.
 */
export function planRefreshReplace(items: readonly StoredItem[], word: string, vocabs: readonly VocabCard[]): RefreshReplacePlan {
  const spelling = word.toLowerCase().trim();
  const oldItems = items.filter(item => !item.isDeleted && isVocabItem(item) && getItemSpelling(item) === spelling);
  const updates: StoredItem[] = [];
  const created: StoredItem[] = [];
  for (const vocab of vocabs) {
    const match = oldItems.find(old => ((old.data as VocabCard).sense || '') === (vocab.sense || ''));
    if (match) {
      // The card keeps its picture unless the fresh analysis brings one, which the search never does: pictures
      // come from the Mac's enrichment cycle.
      const prevImage = (match.data as VocabCard).imageUrl;
      updates.push({ ...match, data: { ...vocab, id: match.data.id, imageUrl: vocab.imageUrl ?? prevImage }, srs: match.srs, savedAt: match.savedAt });
    } else {
      created.push(makeVocabStoredItem(vocab));
    }
  }
  return { updates, created };
}
