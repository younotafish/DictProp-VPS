import type { StoredComparison } from '../../types';

/**
 * The comparisons a device keeps for its signed-in user, so they show before the server's list arrives. The list
 * is read back as it was written: entries a build before the comparison cleaning wrote can still be malformed.
 */

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const cacheKey = (userId: string): string => `vps_comparisons_cache_${userId}`;

/** The list kept for `userId`, or null when there's none or it can't be read. */
export function readCachedComparisons(userId: string, storage?: StorageLike): StoredComparison[] | null {
  try {
    const cached = (storage ?? localStorage).getItem(cacheKey(userId));
    if (!cached) return null;
    const parsed: unknown = JSON.parse(cached);
    return Array.isArray(parsed) ? parsed as StoredComparison[] : null;
  } catch {
    return null;
  }
}

/** Keeps `list` for `userId`. Storage that's full or unavailable leaves the list to the server alone. */
export function writeCachedComparisons(userId: string, list: readonly StoredComparison[], storage?: StorageLike): void {
  try {
    (storage ?? localStorage).setItem(cacheKey(userId), JSON.stringify(list));
  } catch { /* ignore */ }
}
