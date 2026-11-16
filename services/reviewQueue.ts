import type { ReviewEvent, SRSData, StoredItem } from '../types';
import { defaultStorage, parseJson, type StorageLike } from './browserStorage';

export interface PendingReviewMutation {
  event: ReviewEvent;
  itemIds: string[];
  optimisticSrs: Record<string, SRSData>;
  /**
   * The reviewed item as it was before the review, for a server that has never stored it: an implicit
   * catalog sentence on its first review, or an item whose first push hasn't landed yet.
   */
  seedItem?: StoredItem;
}

/** The outbox lists its keys, so it needs storage that enumerates them. */
type OutboxStorage = StorageLike & Pick<Storage, 'key' | 'length'>;

// Builds before per-review keys kept the outbox as one array under this key, and each change rewrote the
// whole array, so two tabs changing it at once could drop each other's reviews. Each review now has a key
// of its own, written and removed whole. The array is still read, and drains as its reviews are delivered.
// Those builds read only the array: after a rollback to one, reviews queued under their own keys wait,
// untouched, until a newer build sends them. Each card keeps its new schedule meanwhile and sends it with
// the card; only the review's history entry waits.
const pendingKey = (userId: string) => `review_mutations_pending_${userId}`;
const entryKey = (userId: string, eventId: string) => `${pendingKey(userId)}:${eventId}`;

const isPendingReviewMutation = (mutation: any): mutation is PendingReviewMutation =>
  !!mutation && typeof mutation.event?.id === 'string' &&
  Array.isArray(mutation.itemIds) && mutation.itemIds.every((id: unknown) => typeof id === 'string') &&
  !!mutation.optimisticSrs && typeof mutation.optimisticSrs === 'object';

const readLegacyMutations = (userId: string, storage: StorageLike): PendingReviewMutation[] => {
  const parsed = parseJson(storage.getItem(pendingKey(userId)));
  return Array.isArray(parsed) ? parsed.filter(isPendingReviewMutation) : [];
};

const reviewedAt = (mutation: PendingReviewMutation) =>
  Number.isFinite(mutation.event.reviewedAt) ? mutation.event.reviewedAt : 0;

/** The reviews waiting to reach the server, in the order they were made. */
export function readPendingReviewMutations(
  userId: string,
  storage: OutboxStorage | null = defaultStorage(),
): PendingReviewMutation[] {
  if (!storage || !userId) return [];
  try {
    const byId = new Map(readLegacyMutations(userId, storage).map(mutation => [mutation.event.id, mutation]));
    const prefix = `${pendingKey(userId)}:`;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const mutation = parseJson(storage.getItem(key));
      // An entry under another review's key could never be removed, and would be sent again and again.
      if (isPendingReviewMutation(mutation) && key === entryKey(userId, mutation.event.id)) {
        byId.set(mutation.event.id, mutation);
      }
    }
    return Array.from(byId.values()).sort((a, b) => reviewedAt(a) - reviewedAt(b));
  } catch {
    return [];
  }
}

/** Returns false when the outbox couldn't store the mutation, so the caller syncs the review another way. */
export function enqueuePendingReviewMutation(
  userId: string,
  mutation: PendingReviewMutation,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage || !userId) return false;
  try {
    storage.setItem(entryKey(userId, mutation.event.id), JSON.stringify(mutation));
    return true;
  } catch {
    return false;
  }
}

export function removePendingReviewMutation(
  userId: string,
  eventId: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage || !userId) return;
  try {
    storage.removeItem(entryKey(userId, eventId));
    const legacy = readLegacyMutations(userId, storage);
    const rest = legacy.filter(mutation => mutation.event.id !== eventId);
    if (rest.length === legacy.length) return;
    if (rest.length === 0) storage.removeItem(pendingKey(userId));
    else storage.setItem(pendingKey(userId), JSON.stringify(rest));
  } catch {
    // A review that stays queued is sent again, and the server ignores a review it has applied.
  }
}

export function excludePendingReviewItems<T extends { data: { id: string } }>(
  items: readonly T[],
  userId: string,
): T[] {
  const pendingIds = new Set(
    readPendingReviewMutations(userId).flatMap(mutation => mutation.itemIds),
  );
  return items.filter(item => !pendingIds.has(item.data.id));
}

export function overlayPendingReviews(
  items: StoredItem[],
  mutations: readonly PendingReviewMutation[],
): StoredItem[] {
  if (mutations.length === 0) return items;
  const patches = new Map<string, { srs: SRSData; reviewedAt: number }>();
  for (const mutation of mutations) {
    for (const [id, srs] of Object.entries(mutation.optimisticSrs)) {
      const current = patches.get(id);
      if (!current || mutation.event.reviewedAt >= current.reviewedAt) {
        patches.set(id, { srs, reviewedAt: mutation.event.reviewedAt });
      }
    }
  }

  return items.map(item => {
    const patch = patches.get(item.data.id);
    if (!patch) return item;
    const currentReview = item.srs?.lastReviewDate || 0;
    const patchReview = patch.srs.lastReviewDate || patch.reviewedAt;
    const patchIsNewer = patchReview > currentReview ||
      (patchReview === currentReview && patch.srs.totalReviews > (item.srs?.totalReviews || 0));
    return patchIsNewer
      ? { ...item, srs: { ...patch.srs, id: item.data.id, type: item.type }, updatedAt: Math.max(item.updatedAt || 0, patch.reviewedAt) }
      : item;
  });
}
