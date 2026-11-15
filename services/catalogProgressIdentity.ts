import type { SentenceData, StoredItem } from '../types';

/**
 * Which read-only catalog, Real Life or the Essays, a record keeps review progress for. Each such record is a
 * sentence item whose id is its catalog's prefix followed by the line's id, so reviewing a line never touches the
 * other catalog or the Sentences tab. Nothing here is imported at run time, so the app shell can classify records
 * without loading either catalog or the progress code in catalogProgress.ts.
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
