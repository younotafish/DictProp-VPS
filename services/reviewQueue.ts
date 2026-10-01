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

const defaultStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

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

// The answers /reviews/apply gives a mutation it will refuse on every retry: malformed, its item gone or
// someone else's, or too large. A failed sign-in, a timeout, rate limiting or a server error can pass.
const REFUSED_REVIEW_STATUSES = new Set([400, 404, 409, 410, 413, 422]);

/** Whether the server refused a review mutation for good, so retrying it would only hold back the rest. */
export const isRefusedReviewMutation = (error: unknown): boolean =>
  error instanceof HttpError && REFUSED_REVIEW_STATUSES.has(error.status);

/** A review the server refused for good, so it never entered the server's review history. No item bodies. */
export interface RefusedReview {
  itemId: string;
  word: string;
  reviewedAt: number;
  reason: string;
  /** When this device recorded the refusal. */
  recordedAt: number;
}

export interface RefusedReviewLog {
  /** Oldest first, at most MAX_REFUSED_REVIEWS. */
  entries: RefusedReview[];
  /** The refusals recorded up to this time were shown and dismissed. */
  dismissedAt: number;
}

const refusalsKey = (userId: string) => `review_refusals_${userId}`;
const MAX_REFUSED_REVIEWS = 50;
const NO_REFUSALS: RefusedReviewLog = { entries: [], dismissedAt: 0 };
const refusalListeners = new Set<() => void>();

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function readRefusedReviews(
  userId: string,
  storage: StorageLike | null = defaultStorage(),
): RefusedReviewLog {
  if (!storage || !userId) return NO_REFUSALS;
  try {
    const parsed = JSON.parse(storage.getItem(refusalsKey(userId)) || 'null');
    if (!parsed || !Array.isArray(parsed.entries)) return NO_REFUSALS;
    const entries = parsed.entries.filter((entry: Partial<RefusedReview> | null): entry is RefusedReview =>
      !!entry && typeof entry.itemId === 'string' && typeof entry.word === 'string' &&
      typeof entry.reason === 'string' && Number.isFinite(entry.reviewedAt) && Number.isFinite(entry.recordedAt),
    );
    return { entries, dismissedAt: Number.isFinite(parsed.dismissedAt) ? parsed.dismissedAt : 0 };
  } catch {
    return NO_REFUSALS;
  }
}

function writeRefusedReviews(userId: string, log: RefusedReviewLog, storage: StorageLike | null): boolean {
  if (!storage || !userId) return false;
  try {
    if (log.entries.length === 0) storage.removeItem(refusalsKey(userId));
    else storage.setItem(refusalsKey(userId), JSON.stringify(log));
  } catch {
    return false;
  }
  for (const listener of refusalListeners) listener();
  return true;
}

/** Keeps a refused review for the user to see, with the newest MAX_REFUSED_REVIEWS. False if it couldn't be stored. */
export function recordRefusedReview(
  userId: string,
  review: Omit<RefusedReview, 'recordedAt'>,
  storage: StorageLike | null = defaultStorage(),
  now = Date.now(),
): boolean {
  const log = readRefusedReviews(userId, storage);
  const entry: RefusedReview = {
    itemId: clip(review.itemId, 200),
    word: clip(review.word.trim() || review.itemId, 120),
    reviewedAt: review.reviewedAt,
    reason: clip(review.reason, 200),
    recordedAt: now,
  };
  return writeRefusedReviews(userId, { ...log, entries: [...log.entries, entry].slice(-MAX_REFUSED_REVIEWS) }, storage);
}

/** Hides the notice until another review is refused. The list keeps every entry. */
export function dismissRefusedReviews(
  userId: string,
  storage: StorageLike | null = defaultStorage(),
  now = Date.now(),
): void {
  const log = readRefusedReviews(userId, storage);
  if (log.entries.some(entry => entry.recordedAt > log.dismissedAt)) writeRefusedReviews(userId, { ...log, dismissedAt: now }, storage);
}

export function clearRefusedReviews(userId: string, storage: StorageLike | null = defaultStorage()): void {
  writeRefusedReviews(userId, NO_REFUSALS, storage);
}

/** How many refusals arrived since the notice was last dismissed. */
export const unseenRefusedReviews = (log: RefusedReviewLog): number =>
  log.entries.filter(entry => entry.recordedAt > log.dismissedAt).length;

/** Calls `listener` when the refusal log changes, in this tab or another. */
export function subscribeRefusedReviews(listener: () => void): () => void {
  refusalListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith('review_refusals_')) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    refusalListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

const REFUSAL_REASONS: Record<number, string> = {
  400: 'The server couldn’t read it',
  404: 'The card isn’t on the server',
  409: 'It clashed with a newer change',
  410: 'The card isn’t on the server',
  413: 'It was too large to send',
  422: 'The server couldn’t read it',
};

/** Why the server refused a review, in words, with what the server said. */
export function describeRefusedReview(error: unknown): string {
  if (!(error instanceof HttpError)) return error instanceof Error ? error.message : 'Refused';
  const reason = REFUSAL_REASONS[error.status] ?? `Refused (${error.status})`;
  return error.responseBody ? `${reason}: ${error.responseBody}` : reason;
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
