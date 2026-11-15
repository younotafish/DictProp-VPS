import { getItemTitle, type StoredItem, type VocabCard } from '../../types';

/**
 * The saved copy of the card on screen: the same id, else a saved phrase with the same title, or a saved word with
 * the same title and exact sense label.
 */
export const findSavedCard = (savedItems: readonly StoredItem[], data: StoredItem['data'], title: string): StoredItem | undefined =>
  savedItems.find(item => item.data.id === data.id) ||
  savedItems.find(item =>
    getItemTitle(item).toLowerCase().trim() === (title || '').toLowerCase().trim() &&
    (item.type === 'phrase' || (item.data as VocabCard).sense === (data as VocabCard).sense)
  );
