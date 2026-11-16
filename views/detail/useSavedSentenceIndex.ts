import { useMemo } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity';
import { isCatalogProgressItem } from '../../services/catalogProgressIdentity';

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

export type SavedSentenceIndex = ReturnType<typeof indexSavedSentences>;

/**
 * indexSavedSentences for one library snapshot, built the first time a lookup reads byId or byIdentity and kept for
 * that snapshot. Only an example preview looks its saved copy up, so the new snapshot a listen or a Got it hands the
 * view normalizes nothing until a preview asks.
 */
export function lazySavedSentenceIndex(
  savedSentenceItems: readonly StoredItem[],
  build: (items: readonly StoredItem[]) => SavedSentenceIndex = indexSavedSentences,
): SavedSentenceIndex {
  let index: SavedSentenceIndex | undefined;
  const built = () => (index ??= build(savedSentenceItems));
  return {
    get byId() { return built().byId; },
    get byIdentity() { return built().byIdentity; },
  };
}

/**
 * The saved sentences' index, new with each library change and built when a lookup first reads it
 * (lazySavedSentenceIndex): previews look up on every render, so the sentences are normalized once per change, and
 * only while a preview needs them.
 */
export function useSavedSentenceIndex(savedSentenceItems: readonly StoredItem[]): SavedSentenceIndex {
  return useMemo(() => lazySavedSentenceIndex(savedSentenceItems), [savedSentenceItems]);
}

/** Whether the library holds the saved sentence `id`, not deleted: a scan by id, with no index to build. */
export const holdsSavedSentence = (savedSentenceItems: readonly StoredItem[], id: string): boolean =>
  savedSentenceItems.some(item => item.type === 'sentence' && !item.isDeleted && item.data.id === id);
