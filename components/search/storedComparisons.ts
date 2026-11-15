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
 * `toUpload` lists the local copies the server lacks or holds an older version of.
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
    if (mine && mine.updatedAt > entry.updatedAt) {
      merged.push(mine);
      toUpload.push(mine);
    } else {
      merged.push(entry);
    }
  }
  for (const entry of localOnly.values()) {
    merged.push(entry);
    toUpload.push(entry);
  }
  return { merged, toUpload };
}
