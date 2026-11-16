import type { StoredComparison } from '../../types';
import { sanitizeStoredComparisons } from '../../services/api/comparisons';
import { parseJson, type StorageLike } from '../../services/browserStorage';

/**
 * The comparisons a device keeps for its signed-in user, so they show before the server's list arrives. The list is
 * cleaned when it's read, as the server's is, since a build from before the comparison cleaning may have cached
 * malformed entries.
 */

/** The cache only reads and writes, so a test can pass a storage that has just those two methods. */
type ReadWriteStorage = Pick<StorageLike, 'getItem' | 'setItem'>;

const cacheKey = (userId: string): string => `vps_comparisons_cache_${userId}`;

/** The list kept for `userId`, cleaned for display, or null when there's none or it can't be read. */
export function readCachedComparisons(userId: string, storage?: ReadWriteStorage): StoredComparison[] | null {
  try {
    const parsed = parseJson((storage ?? localStorage).getItem(cacheKey(userId)));
    return Array.isArray(parsed) ? sanitizeStoredComparisons(parsed) : null;
  } catch {
    return null;
  }
}

/** Keeps `list` for `userId`. Storage that's full or unavailable leaves the list to the server alone. */
export function writeCachedComparisons(userId: string, list: readonly StoredComparison[], storage?: ReadWriteStorage): void {
  try {
    (storage ?? localStorage).setItem(cacheKey(userId), JSON.stringify(list));
  } catch { /* ignore */ }
}

/** Whether `entry` looks like a stored comparison: a key, its words, the result, and when it was made. */
const isStoredComparison = (entry: unknown): entry is StoredComparison => {
  if (!entry || typeof entry !== 'object') return false;
  const { key, words, data, updatedAt } = entry as Partial<StoredComparison>;
  return typeof key === 'string' && key !== ''
    && Array.isArray(words) && words.every(word => typeof word === 'string')
    && !!data && typeof data === 'object'
    && Number.isFinite(updatedAt);
};

/**
 * The comparison list once the server's list has arrived: the server's copies, each replaced by this device's copy
 * when that one is newer, then the comparisons only this device has (one that finished while the list was
 * loading, or one whose save failed). A tie goes to the server's copy, and a malformed local entry is dropped.
 * `toUpload` lists the local copies the server lacks. A word set the server holds is never sent again, even when
 * this device's copy is newer: the device stamps a copy with its own clock, which the server caps at a few minutes
 * ahead of its own, so a device whose clock runs fast would keep replacing a copy another device saved later.
 */
export function mergeComparisons(
  local: readonly StoredComparison[],
  server: readonly StoredComparison[],
): { merged: StoredComparison[]; toUpload: StoredComparison[] } {
  const localOnly = new Map<string, StoredComparison>();
  for (const entry of local) if (isStoredComparison(entry)) localOnly.set(entry.key, entry);
  const merged: StoredComparison[] = [];
  const toUpload: StoredComparison[] = [];
  for (const entry of server) {
    const mine = localOnly.get(entry.key);
    localOnly.delete(entry.key);
    merged.push(mine && mine.updatedAt > entry.updatedAt ? mine : entry);
  }
  for (const entry of localOnly.values()) {
    merged.push(entry);
    toUpload.push(entry);
  }
  return { merged, toUpload };
}
