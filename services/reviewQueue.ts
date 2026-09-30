import type { ReviewEvent, SRSData, StoredItem } from '../types';
import { HttpError } from './http';

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

/** Returns whether the outbox now holds `mutations`: localStorage may be unavailable or full. */
function writePendingReviewMutations(
  userId: string,
  mutations: PendingReviewMutation[],
  storage: StorageLike | null,
): boolean {
  if (!storage || !userId) return false;
  try {
    if (mutations.length === 0) storage.removeItem(pendingKey(userId));
    else storage.setItem(pendingKey(userId), JSON.stringify(mutations));
    return true;
  } catch {
    return false;
  }
}

/** Returns false when the outbox couldn't store the mutation, so the caller syncs the review another way. */
export function enqueuePendingReviewMutation(
  userId: string,
  mutation: PendingReviewMutation,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const pending = readPendingReviewMutations(userId, storage)
    .filter(current => current.event.id !== mutation.event.id);
  pending.push(mutation);
  return writePendingReviewMutations(userId, pending, storage);
}

// The answers /reviews/apply gives a mutation it will refuse on every retry: malformed, its item gone or
// someone else's, or too large. A failed sign-in, a timeout, rate limiting or a server error can pass.
const REFUSED_REVIEW_STATUSES = new Set([400, 404, 409, 410, 413, 422]);

/** Whether the server refused a review mutation for good, so retrying it would only hold back the rest. */
export const isRefusedReviewMutation = (error: unknown): boolean =>
  error instanceof HttpError && REFUSED_REVIEW_STATUSES.has(error.status);

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
