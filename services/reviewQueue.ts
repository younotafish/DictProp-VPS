import type { ReviewEvent, SRSData, StoredItem } from '../types';

export interface PendingReviewMutation {
  event: ReviewEvent;
  itemIds: string[];
  optimisticSrs: Record<string, SRSData>;
  /** Base item used when the first review materializes an implicit catalog sentence. */
  seedItem?: StoredItem;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const pendingKey = (userId: string) => `review_mutations_pending_${userId}`;

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function readPendingReviewMutations(
  userId: string,
  storage: StorageLike | null = defaultStorage(),
): PendingReviewMutation[] {
  if (!storage || !userId) return [];
  try {
    const parsed = JSON.parse(storage.getItem(pendingKey(userId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((mutation): mutation is PendingReviewMutation =>
      !!mutation && typeof mutation.event?.id === 'string' &&
      Array.isArray(mutation.itemIds) && mutation.itemIds.every((id: unknown) => typeof id === 'string') &&
      !!mutation.optimisticSrs && typeof mutation.optimisticSrs === 'object',
    );
  } catch {
    return [];
  }
}

function writePendingReviewMutations(
  userId: string,
  mutations: PendingReviewMutation[],
  storage: StorageLike | null,
): void {
  if (!storage || !userId) return;
  try {
    if (mutations.length === 0) storage.removeItem(pendingKey(userId));
    else storage.setItem(pendingKey(userId), JSON.stringify(mutations));
  } catch {
    // IndexedDB journaling remains the fallback when localStorage is unavailable/full.
  }
}

export function enqueuePendingReviewMutation(
  userId: string,
  mutation: PendingReviewMutation,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  const pending = readPendingReviewMutations(userId, storage)
    .filter(current => current.event.id !== mutation.event.id);
  pending.push(mutation);
  writePendingReviewMutations(userId, pending, storage);
}

export function removePendingReviewMutation(
  userId: string,
  eventId: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  writePendingReviewMutations(
    userId,
    readPendingReviewMutations(userId, storage).filter(mutation => mutation.event.id !== eventId),
    storage,
  );
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
