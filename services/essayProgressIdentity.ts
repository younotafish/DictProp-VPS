import type { StoredItem } from '../types';
import { catalogProgressItemId, catalogProgressKind } from './catalogProgressIdentity';

// The essay half of catalogProgressIdentity, for the modules that import it from here. Catalog-free, like it.

export function essayProgressItemId(catalogSentenceId: string): string {
  return catalogProgressItemId('essay', catalogSentenceId);
}

export function isEssayProgressItem(item: StoredItem): boolean {
  return catalogProgressKind(item) === 'essay';
}
