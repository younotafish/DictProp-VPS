import type { SentenceData, StoredItem } from '../types';

/** Kept catalog-free so the app shell can classify progress records without loading 720 sentences. */
export const REAL_LIFE_PROGRESS_PREFIX = 'real-life-sentence:';

export function realLifeProgressItemId(catalogSentenceId: string): string {
  return `${REAL_LIFE_PROGRESS_PREFIX}${catalogSentenceId}`;
}

export function isRealLifeProgressItem(item: StoredItem): boolean {
  if (item.type !== 'sentence' || !item.data.id.startsWith(REAL_LIFE_PROGRESS_PREFIX)) return false;
  const data = item.data as SentenceData;
  return !!data.catalogSentenceId && !!data.catalogCollectionId &&
    realLifeProgressItemId(data.catalogSentenceId) === item.data.id;
}
