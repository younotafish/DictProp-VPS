import { getItemSpelling, isVocabItem, type StoredItem, type VocabCard } from '../types';
import { makeVocabStoredItem, sameItemContent } from './items';

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

/**
 * The undo the refresh's undo offer holds: useUndoOffer calls it with the current copy of each card the refresh saved
 * (`ids`), and the refresh took the library from `before` to `after`.
 * - A card untouched since gets its copy from before back, exactly, which matches the server's again, so nothing is
 *   pushed. That includes a deleted card the refresh brought back (handleSave's rule for a sense saved again).
 * - A card reviewed since keeps its new schedule and gets everything else back from before, stamped `now`.
 * - A card the refresh added is deleted, as Delete does, even when reviewed since: it wasn't there before.
 * A card whose content or flags changed since in any other way (another save, a merge from another device) is left as
 * it is, and so is every other item.
 */
export function undoRefreshReplace(
  before: readonly StoredItem[],
  after: readonly StoredItem[],
  ids: Iterable<string>,
  now: () => number = Date.now,
): (item: StoredItem) => StoredItem {
  const cards = new Map<string, { before: StoredItem | undefined; after: StoredItem }>();
  for (const id of ids) {
    const refreshed = after.find(item => item.data.id === id);
    if (refreshed) cards.set(id, { before: before.find(item => item.data.id === id), after: refreshed });
  }
  return item => {
    const card = cards.get(item.data.id);
    if (!card) return item;
    const { before: original, after: refreshed } = card;
    // A review replaces only the schedule and the sync record around the same content.
    const reviewedAtMost = sameItemContent(item, refreshed) && item.isDeleted === refreshed.isDeleted && item.isArchived === refreshed.isArchived;
    if (!reviewedAtMost) return item;
    if (!original) return { ...item, isDeleted: true, updatedAt: now() };
    if (item === refreshed) return original;
    return { ...original, srs: item.srs, serverRevision: item.serverRevision, lastSyncedHash: item.lastSyncedHash, updatedAt: now() };
  };
}
