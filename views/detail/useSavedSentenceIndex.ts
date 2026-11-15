import { useMemo } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity';

/**
 * The library's saved sentences by id and by normalized text, for the lookups that bind a preview to its saved
 * copy. Previews look up on every render, so the sentences are normalized once per library change rather than
 * on each lookup.
 */
export function useSavedSentenceIndex(savedSentenceItems: StoredItem[]) {
  return useMemo(() => {
    const byId = new Map<string, StoredItem>();
    const byIdentity = new Map<string, StoredItem[]>();
    for (const item of savedSentenceItems) {
      if (item.type !== 'sentence' || item.isDeleted) continue;
      byId.set(item.data.id, item);
      const identity = normalizeSentenceIdentity((item.data as SentenceData).text);
      if (!identity) continue;
      const matches = byIdentity.get(identity);
      if (matches) matches.push(item);
      else byIdentity.set(identity, [item]);
    }
    return { byId, byIdentity };
  }, [savedSentenceItems]);
}

export type SavedSentenceIndex = ReturnType<typeof useSavedSentenceIndex>;
