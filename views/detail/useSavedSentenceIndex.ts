import { useMemo } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity';
import { isRealLifeProgressItem } from '../../services/realLifeProgressIdentity';
import { isEssayProgressItem } from '../../services/essayProgressIdentity';

/** A Real Life or Essay sentence's progress record, which belongs to its catalog sentence rather than to its text. */
export const isCatalogProgressItem = (item: StoredItem): boolean => isRealLifeProgressItem(item) || isEssayProgressItem(item);

/**
 * The library's saved sentences by id, and by normalized text for the lookups that bind a preview to its saved
 * copy. A catalog sentence's progress record binds only through its catalog identity, so the text lookup leaves
 * those out: an example that happens to read like a Real Life or Essay sentence stays a preview of its own.
 */
export function indexSavedSentences(savedSentenceItems: readonly StoredItem[]) {
  const byId = new Map<string, StoredItem>();
  const byIdentity = new Map<string, StoredItem[]>();
  for (const item of savedSentenceItems) {
    if (item.type !== 'sentence' || item.isDeleted) continue;
    byId.set(item.data.id, item);
    if (isCatalogProgressItem(item)) continue;
    const identity = normalizeSentenceIdentity((item.data as SentenceData).text);
    if (!identity) continue;
    const matches = byIdentity.get(identity);
    if (matches) matches.push(item);
    else byIdentity.set(identity, [item]);
  }
  return { byId, byIdentity };
}

/**
 * indexSavedSentences, built once per library change: previews look up on every render, so the sentences are
 * normalized once rather than on each lookup.
 */
export function useSavedSentenceIndex(savedSentenceItems: StoredItem[]) {
  return useMemo(() => indexSavedSentences(savedSentenceItems), [savedSentenceItems]);
}

export type SavedSentenceIndex = ReturnType<typeof indexSavedSentences>;
