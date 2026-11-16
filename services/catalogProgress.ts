import type { StoredItem } from '../types';
import { catalogProgressKind, type CatalogKind, type CatalogProgressItem } from './catalogProgressIdentity';
import { summarizeReviewStates, type ReviewSummary } from './sentenceReviewState';

// What the Real Life and Essays screens do with their catalog's progress records (catalogProgressIdentity.ts
// says which records those are): index them, summarize a collection or an essay, and open its lines' records.
// catalogQueue.ts picks the lines a Study run takes.

const isProgressItemOf = (item: StoredItem, kind: CatalogKind): item is CatalogProgressItem =>
  catalogProgressKind(item) === kind;

/** One catalog's progress records, by the id of the catalog sentence each belongs to. */
export type CatalogProgressIndex = ReadonlyMap<string, CatalogProgressItem>;

/** Indexes one catalog's progress records, leaving out deleted ones. */
export function indexCatalogProgress(items: readonly StoredItem[], kind: CatalogKind): CatalogProgressIndex {
  const index = new Map<string, CatalogProgressItem>();
  for (const item of items) {
    if (!item.isDeleted && isProgressItemOf(item, kind)) index.set(item.data.catalogSentenceId, item);
  }
  return index;
}

/** How a run of catalog sentences (a collection, an essay) stands in review. */
export function summarizeCatalogProgress(
  sentences: readonly { id: string }[],
  index: CatalogProgressIndex,
  now: number,
): ReviewSummary {
  return summarizeReviewStates(sentences.map(sentence => index.get(sentence.id)?.srs), now);
}

/** The items a run over `sentences` opens: each one's stored record, or a new one from `create` where none is. */
export function catalogStudyItems<T extends { id: string }>(
  sentences: readonly T[],
  index: CatalogProgressIndex,
  create: (sentence: T) => StoredItem,
): StoredItem[] {
  return sentences.map(sentence => index.get(sentence.id) ?? create(sentence));
}
