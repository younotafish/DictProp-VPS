import { HttpError } from './http';
import { defaultStorage, parseJson, type StorageLike } from './browserStorage';

// Reviews the server refused for good, kept on this device so the user can see what never reached the server's
// review history, and the words that say why.

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

const REFUSALS_KEY_PREFIX = 'review_refusals_';
const refusalsKey = (userId: string) => `${REFUSALS_KEY_PREFIX}${userId}`;
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
    const parsed = parseJson(storage.getItem(refusalsKey(userId))) as { entries?: unknown; dismissedAt?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.entries)) return NO_REFUSALS;
    const entries = parsed.entries.filter((entry: Partial<RefusedReview> | null): entry is RefusedReview =>
      !!entry && typeof entry.itemId === 'string' && typeof entry.word === 'string' &&
      typeof entry.reason === 'string' && Number.isFinite(entry.reviewedAt) && Number.isFinite(entry.recordedAt),
    );
    const dismissedAt = typeof parsed.dismissedAt === 'number' && Number.isFinite(parsed.dismissedAt) ? parsed.dismissedAt : 0;
    return { entries, dismissedAt };
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
    if (event.key === null || event.key.startsWith(REFUSALS_KEY_PREFIX)) listener();
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
