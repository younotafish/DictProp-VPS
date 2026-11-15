import type { StoredItem } from '../types';
import { catalogProgressItemId, catalogProgressKind } from './catalogProgressIdentity';

// The Real Life half of catalogProgressIdentity, for the modules that import it from here. Catalog-free, like
// it, so the app shell can classify progress records without loading the Real Life catalog.

export function realLifeProgressItemId(catalogSentenceId: string): string {
  return catalogProgressItemId('real-life', catalogSentenceId);
}

export function isRealLifeProgressItem(item: StoredItem): boolean {
  return catalogProgressKind(item) === 'real-life';
}
