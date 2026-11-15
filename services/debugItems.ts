import { getItemSpelling, type StoredItem } from '../types';
import { getItemContentHash } from './itemHash';

declare global {
  interface Window {
    /** Prints every copy of a word in the library, for diagnosing sync and schedule problems from the console. */
    __debugItems?: (word: string) => void;
  }
}

/**
 * Puts `__debugItems(word)` on the window, as in `__debugItems('atlas')` or `__debugItems('first half')`. It
 * prints each copy of the word in `getItems()`: its flags, schedule, timestamps and sync hashes. It prints
 * with console.log, which the production build keeps, since the logger is silent there. Returns the function
 * that takes it off again.
 */
export function installDebugItems(getItems: () => readonly StoredItem[]): () => void {
  window.__debugItems = (word: string) => {
    const w = word.toLowerCase().trim();
    const matches = getItems().filter(i => getItemSpelling(i) === w);
    if (matches.length === 0) {
      console.log(`[Debug] No items found for "${word}"`);
      return;
    }
    console.log(`[Debug] Found ${matches.length} item(s) for "${word}":`);
    matches.forEach((item, idx) => {
      console.log(`  [${idx}] id=${item.data.id}, type=${item.type}, deleted=${!!item.isDeleted}, archived=${!!item.isArchived}`);
      console.log(`       SRS: reviews=${item.srs?.totalReviews}, strength=${item.srs?.memoryStrength}, stability=${item.srs?.stability}d, streak=${item.srs?.correctStreak}`);
      console.log(`       lastReview=${item.srs?.lastReviewDate ? new Date(item.srs.lastReviewDate).toISOString() : 'never'}, nextReview=${item.srs?.nextReview ? new Date(item.srs.nextReview).toISOString() : 'N/A'}`);
      console.log(`       updatedAt=${item.updatedAt ? new Date(item.updatedAt).toISOString() : 'N/A'}, savedAt=${new Date(item.savedAt).toISOString()}`);
      console.log(`       lastSyncedHash=${item.lastSyncedHash || 'NONE'}, currentHash=${getItemContentHash(item)}`);
    });
  };
  return () => { delete window.__debugItems; };
}
