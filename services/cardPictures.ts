import { isPhraseItem, type StoredItem } from '../types';

/** The pictures a card shows: its own, and those of the words inside a phrase. */
export const picturesOf = (item: StoredItem): Array<{ id: string; imageUrl: string | undefined }> => [
  { id: item.data.id, imageUrl: item.data.imageUrl },
  ...(isPhraseItem(item) ? (item.data.vocabs ?? []).map(vocab => ({ id: vocab.id, imageUrl: vocab.imageUrl })) : []),
];
