import { getItemSense, getItemSpelling, type StoredItem, type VocabCard } from '../types';
import { normalizeKey, splitForms } from './wordMatch';

const add = (map: Map<string, StoredItem[]>, key: string, item: StoredItem) => {
  const items = map.get(key);
  if (items) items.push(item);
  else map.set(key, [item]);
};

/**
 * Builds the lookup that finds the card a saved sentence belongs to: the card with the sentence's word and
 * sense, else the first with its word. A word no card is spelled as, such as "making time" once its card is
 * named "make time", reaches the cards that list it among their forms, matching the sense first the same
 * way. Deleted cards never match. Returns undefined when no card has the word.
 */
export function sentenceSourceResolver(items: readonly StoredItem[]): (sourceWord?: string, sourceSense?: string) => StoredItem | undefined {
  const bySpelling = new Map<string, StoredItem[]>();
  for (const item of items) {
    if (!item.isDeleted && item.type === 'vocab') add(bySpelling, getItemSpelling(item), item);
  }
  // Built on the first word that matches no spelling; most lookups never need it.
  let byForm: Map<string, StoredItem[]> | undefined;
  return (sourceWord, sourceSense) => {
    const spelling = (sourceWord || '').toLowerCase().trim();
    let matches = bySpelling.get(spelling);
    if (!matches) {
      if (!byForm) {
        byForm = new Map();
        for (const cards of bySpelling.values()) {
          for (const card of cards) for (const form of splitForms((card.data as VocabCard).forms)) add(byForm, form, card);
        }
      }
      matches = byForm.get(normalizeKey(spelling));
    }
    if (!matches) return undefined;
    return (sourceSense ? matches.find(item => getItemSense(item) === sourceSense) : undefined) ?? matches[0];
  };
}
