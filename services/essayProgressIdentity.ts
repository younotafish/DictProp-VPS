import type { SentenceData, StoredItem } from '../types';

/** Essay reviews are namespaced away from ordinary and Real Life sentence queues. */
export const ESSAY_PROGRESS_PREFIX = 'essay-sentence:';

export function essayProgressItemId(catalogSentenceId: string): string {
  return `${ESSAY_PROGRESS_PREFIX}${catalogSentenceId}`;
}

export function isEssayProgressItem(item: StoredItem): boolean {
  if (item.type !== 'sentence' || !item.data.id.startsWith(ESSAY_PROGRESS_PREFIX)) return false;
  const data = item.data as SentenceData;
  return data.catalogKind === 'essay' && !!data.catalogSentenceId && !!data.catalogCollectionId &&
    essayProgressItemId(data.catalogSentenceId) === item.data.id;
}
