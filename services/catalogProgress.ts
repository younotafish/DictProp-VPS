import type { SentenceData, StoredItem } from '../types';
import { needsReview, summarizeReviewStates, type ReviewSummary } from './sentenceReviewState';

/**
 * The records that keep a read-only catalog line's review history, for Real Life and for the Essays. Each is a
 * sentence item whose id is its catalog's prefix followed by the line's id, so reviewing a line never touches
 * the other catalog or the Sentences tab. This module imports neither catalog, so classifying a record loads
 * no catalog.
 */

export type CatalogKind = 'real-life' | 'essay';

export const CATALOG_PROGRESS_PREFIX: Readonly<Record<CatalogKind, string>> = {
  'real-life': 'real-life-sentence:',
  essay: 'essay-sentence:',
};

export function catalogProgressItemId(kind: CatalogKind, catalogSentenceId: string): string {
  return `${CATALOG_PROGRESS_PREFIX[kind]}${catalogSentenceId}`;
}

/** A catalog progress record, with the fields that make it one. */
export type CatalogProgressItem = StoredItem & {
  type: 'sentence';
  data: SentenceData & { catalogSentenceId: string; catalogCollectionId: string };
};

/**
 * The catalog a record keeps progress for, or null for any other item. Its id must be the catalog's prefix
 * followed by its catalogSentenceId, and it must name its collection. An essay record must also say
 * catalogKind 'essay'. A Real Life record needn't: the first ones (2026-08-08) were saved a day before the
 * field existed.
 */
export function catalogProgressKind(item: StoredItem): CatalogKind | null {
  if (item.type !== 'sentence') return null;
  const { id } = item.data;
  const kind: CatalogKind | null = id.startsWith(CATALOG_PROGRESS_PREFIX['real-life']) ? 'real-life'
    : id.startsWith(CATALOG_PROGRESS_PREFIX.essay) ? 'essay'
    : null;
  if (!kind) return null;
  const data = item.data as SentenceData;
  if (kind === 'essay' && data.catalogKind !== 'essay') return null;
  return data.catalogSentenceId && data.catalogCollectionId &&
    catalogProgressItemId(kind, data.catalogSentenceId) === id ? kind : null;
}

/** Whether an item keeps progress for a line of either catalog. */
export function isCatalogProgressItem(item: StoredItem): item is CatalogProgressItem {
  return catalogProgressKind(item) !== null;
}

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

/** What a Study run takes: the sentences never reviewed or due again, or all of them when none are. */
export function sentencesToStudy<T extends { id: string }>(
  sentences: readonly T[],
  index: CatalogProgressIndex,
  now: number,
): readonly T[] {
  const actionable = sentences.filter(sentence => needsReview(index.get(sentence.id)?.srs, now));
  return actionable.length > 0 ? actionable : sentences;
}
