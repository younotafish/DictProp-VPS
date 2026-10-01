import { useCallback, useRef } from 'react';
import { getItemTitle, type ReviewEvent, type ReviewRating, type ReviewTaskType, type StoredItem } from '../types';
import type { AuthUser } from '../services/auth';
import { saveItemUpdates } from '../services/storage';
import { reconcileReviewedItem } from '../services/sync';
import { getItemContentHash, isItemDirty } from '../services/itemHash';
import { applyReviewMutation, undoReviewMutation, type AppliedReviewResponse } from '../services/api';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { describeRefusedReview, enqueuePendingReviewMutation, isRefusedReviewMutation, readPendingReviewMutations, recordRefusedReview, removePendingReviewMutation, type PendingReviewMutation } from '../services/reviewQueue';
import { isRealLifeProgressItem } from '../services/realLifeProgressIdentity';
import { isEssayProgressItem } from '../services/essayProgressIdentity';
import { log, warn, error as logError } from '../services/logger';
import { useReviewHistory } from './useReviewHistory';
import type { Library } from './useLibrary';

// The FSRS scheduler stays out of the first code the app loads. It's fetched with the other screens once the
// first one is up, so a review normally finds it here.
let fsrsScheduler: typeof import('../services/fsrsScheduler') | undefined;
export const loadFsrsScheduler = () => import('../services/fsrsScheduler').then(module => (fsrsScheduler = module));

/**
 * Reviews: each one is recorded in the review history and in the local outbox before anything else, and the
 * outbox applies it on the server atomically, so a reload, a crash or going offline doesn't lose it.
 */
export function useReviewOutbox(
  user: AuthUser | null,
  { latestItemsRef, currentUserIdRef, updateItems }: Pick<Library, 'latestItemsRef' | 'currentUserIdRef' | 'updateItems'>,
) {
  const { reviewHistory, recordReview, removeReview } = useReviewHistory(user?.id);
  const reviewFlushPromiseRef = useRef<Promise<void> | null>(null);

  const reconcileAppliedReview = useCallback(async (
    serverItems: StoredItem[],
    baseRevisions: Record<string, number> = {},
  ) => {
    if (serverItems.length === 0) return;
    const byId = new Map(serverItems.map(item => [item.data.id, item]));
    const nextItems = updateItems(items => items.map(local => {
      const serverItem = byId.get(local.data.id);
      return serverItem ? reconcileReviewedItem(local, serverItem, baseRevisions[local.data.id]) : local;
    }));
    await saveItemUpdates(
      nextItems.filter(item => byId.has(item.data.id)),
      currentUserIdRef.current,
    );
  }, [updateItems]);

  const markItemsUnsynced = useCallback(async (itemIds: readonly string[]) => {
    const ids = new Set(itemIds);
    const nextItems = updateItems(items => items.map(item =>
      ids.has(item.data.id) && item.lastSyncedHash !== undefined ? { ...item, lastSyncedHash: undefined } : item,
    ));
    await saveItemUpdates(nextItems.filter(item => ids.has(item.data.id)), currentUserIdRef.current);
  }, [updateItems]);

  const flushPendingReviews = useCallback(async () => {
    const userId = user?.id;
    if (!userId || !navigator.onLine) return;
    if (reviewFlushPromiseRef.current) return reviewFlushPromiseRef.current;
    const runFlush = async () => {
      try {
        // A review storage wouldn't let go of comes round again; the next flush resends it (the server
        // ignores a repeat) instead of this one sending it in a loop.
        const sent = new Set<string>();
        for (;;) {
          const mutation = readPendingReviewMutations(userId).find(pending => !sent.has(pending.event.id));
          if (!mutation) break;
          sent.add(mutation.event.id);
          let response: AppliedReviewResponse;
          try {
            response = await applyReviewMutation(mutation.event, mutation.itemIds, mutation.seedItem);
          } catch (error) {
            if (!isRefusedReviewMutation(error)) throw error;
            // A retry would be refused the same way and hold back every review queued behind this one. The
            // reviewed copies already hold the new schedule, so the item push delivers it instead. The user
            // hears of it (components/RefusedReviews): the review itself never counts on the server.
            warn('Review was refused; its schedule will sync with the item:', error);
            const reviewed = latestItemsRef.current.find(item => item.data.id === mutation.event.itemId) ?? mutation.seedItem;
            recordRefusedReview(userId, {
              itemId: mutation.event.itemId,
              word: reviewed ? getItemTitle(reviewed) : mutation.event.itemId,
              reviewedAt: mutation.event.reviewedAt,
              reason: describeRefusedReview(error),
            });
            removePendingReviewMutation(userId, mutation.event.id);
            await markItemsUnsynced(mutation.itemIds);
            continue;
          }
          await reconcileAppliedReview(response.items, response.baseRevisions);
          removePendingReviewMutation(userId, mutation.event.id);
        }
      } catch (error) {
        warn('Pending review sync will retry:', error);
      }
    };
    const flush = navigator.locks
      ? navigator.locks.request(`dictprop-review-flush:${userId}`, runFlush)
      : runFlush();
    reviewFlushPromiseRef.current = flush;
    try {
      await flush;
    } finally {
      if (reviewFlushPromiseRef.current === flush) reviewFlushPromiseRef.current = null;
    }
  }, [user?.id, markItemsUnsynced, reconcileAppliedReview]);

  const undoSRSReview = useCallback(async (eventId: string): Promise<void> => {
    const userId = user?.id;
    if (!userId) throw new Error('Sign in again before undoing this review.');
    await flushPendingReviews();
    if (readPendingReviewMutations(userId).some(mutation => mutation.event.id === eventId)) {
      throw new Error(navigator.onLine ? 'This review is still syncing. Try undo again.' : 'Reconnect to undo this review.');
    }
    const response = await undoReviewMutation(eventId);
    await reconcileAppliedReview(response.items, response.baseRevisions);
    removeReview(eventId);
  }, [user?.id, flushPendingReviews, reconcileAppliedReview, removeReview]);

  // SRS update for one sense/item. The server applies the same FSRS transition atomically.
  //
  // The reviewed copy is computed from latestItemsRef.current before any state update, so the review
  // outbox, the immediate IndexedDB write and the rendered library all hold the same copy.
  const updateSRS = useCallback(async (
    itemId: string,
    rating: ReviewRating = 'good',
    context?: {
      taskType?: ReviewTaskType;
      durationMs?: number;
      sessionId?: string;
      eventId?: string;
      /** Materializes an implicit catalog sentence on its first review. */
      seedItem?: StoredItem;
    },
  ): Promise<boolean> => {
    const { updateAfterRating } = fsrsScheduler ?? await loadFsrsScheduler();
    const now = Date.now();
    const userId = currentUserIdRef.current;

    const savedItem = latestItemsRef.current.find(i => i.data.id === itemId);
    const requestedSeed = context?.seedItem;
    const catalogSeed = !savedItem && requestedSeed?.data.id === itemId &&
      (isRealLifeProgressItem(requestedSeed) || isEssayProgressItem(requestedSeed))
      ? requestedSeed
      : undefined;
    const targetItem = savedItem ?? catalogSeed;
    if (!targetItem) return false;

    const targetTitle = getItemTitle(targetItem).toLowerCase().trim();
    const baseSRS = SRSAlgorithm.ensure(targetItem.srs, targetItem.data.id, targetItem.type);
    const updatedSRS = updateAfterRating(baseSRS, rating, now);
    // An item the server has never stored (saved offline, or its first push still pending) travels with its
    // review as a seed, since the item push waits for the review: without one, the server has nothing to apply
    // the review to, and the two would wait on each other forever.
    const seedItem = catalogSeed ?? (targetItem.serverRevision === undefined
      ? { ...targetItem, srs: { ...baseSRS, id: itemId } }
      : undefined);
    const reviewEvent: ReviewEvent = {
      id: context?.eventId || crypto.randomUUID(), itemId, itemType: targetItem.type, reviewedAt: now,
      previousStep: baseSRS.totalReviews, nextStep: updatedSRS.totalReviews,
      rating,
      taskType: context?.taskType || 'quick',
      durationMs: context?.durationMs,
      sessionId: context?.sessionId,
    };

    log(`🧠 FSRS Update: ${targetTitle} - ${rating}, stability=${updatedSRS.stability.toFixed(1)}d, next review in ${updatedSRS.interval}m`);

    const reviewed: StoredItem = { ...targetItem, srs: { ...updatedSRS, id: itemId }, updatedAt: now };
    const reviewMutation: PendingReviewMutation = {
      event: reviewEvent,
      itemIds: [itemId],
      optimisticSrs: { [itemId]: reviewed.srs },
      ...(seedItem ? { seedItem } : {}),
    };

    // The small localStorage outbox is synchronous and lands before React or IndexedDB work. Its
    // idempotent event id is the crash/reload boundary for offline and rapid reviews.
    const queued = enqueuePendingReviewMutation(userId, reviewMutation);
    // The review outbox, not the item push, carries the new schedule (and a seed item) to the server.
    // A copy that matched the server before the review stays clean, so reconciling the applied review
    // adopts the server's content instead of mistaking the new schedule for an unsynced edit. When the
    // outbox can't hold the review (storage full or unavailable), the copy stays dirty for the push to carry.
    const reviewedItem = queued && (seedItem || !isItemDirty(targetItem))
      ? { ...reviewed, lastSyncedHash: getItemContentHash(reviewed) }
      : reviewed;
    recordReview(reviewEvent);
    updateItems(items => {
      const index = items.findIndex(item => item.data.id === itemId);
      if (index < 0) return catalogSeed ? [...items, reviewedItem] : items;
      const next = items.slice();
      next[index] = reviewedItem;
      return next;
    });

    // CRITICAL: save to IndexedDB immediately (primary persistence — never lose progress on a quick
    // refresh / app switch).
    try {
      await saveItemUpdates([reviewedItem], userId);
    } catch (e) {
      logError('💾 Failed to save SRS update to IndexedDB:', e);
    }

    await flushPendingReviews();
    return !readPendingReviewMutations(userId).some(mutation => mutation.event.id === reviewEvent.id);
  }, [user?.id, recordReview, updateItems, flushPendingReviews]);

  return { reviewHistory, flushPendingReviews, undoSRSReview, updateSRS };
}
