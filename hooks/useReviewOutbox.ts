import { useCallback, useRef } from 'react';
import { getItemTitle, type ReviewEvent, type ReviewRating, type ReviewTaskType, type StoredItem } from '../types';
import { reconcileReviewedItem } from '../services/sync';
import { getItemContentHash, isItemDirty } from '../services/itemHash';
import { applyReviewMutation, undoReviewMutation } from '../services/api/library';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { enqueuePendingReviewMutation, readPendingReviewMutations, removePendingReviewMutation, type PendingReviewMutation } from '../services/reviewQueue';
import { describeRefusedReview, isRefusedReviewMutation, recordRefusedReview } from '../services/refusedReviews';
import { drainReviewOutbox, reviewSeed } from '../services/reviewOutbox';
import { isCatalogProgressItem } from '../services/catalogProgressIdentity';
import { log, logError, warn } from '../services/logger';
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
  userId: string,
  { latestItemsRef, updateItems, storeItemUpdates }: Pick<Library, 'latestItemsRef' | 'updateItems' | 'storeItemUpdates'>,
) {
  const { reviewHistory, recordReview, removeReview } = useReviewHistory(userId);
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
    await storeItemUpdates(nextItems.filter(item => byId.has(item.data.id)));
  }, [updateItems, storeItemUpdates]);

  const markItemsUnsynced = useCallback(async (itemIds: readonly string[]) => {
    const ids = new Set(itemIds);
    const nextItems = updateItems(items => items.map(item =>
      ids.has(item.data.id) && item.lastSyncedHash !== undefined ? { ...item, lastSyncedHash: undefined } : item,
    ));
    await storeItemUpdates(nextItems.filter(item => ids.has(item.data.id)));
  }, [updateItems, storeItemUpdates]);

  const flushPendingReviews = useCallback(async () => {
    if (!navigator.onLine) return;
    if (reviewFlushPromiseRef.current) return reviewFlushPromiseRef.current;
    const runFlush = async () => {
      try {
        await drainReviewOutbox({
          read: () => readPendingReviewMutations(userId),
          apply: mutation => applyReviewMutation(mutation.event, mutation.itemIds, mutation.seedItem),
          isRefused: isRefusedReviewMutation,
          reconcile: response => reconcileAppliedReview(response.items, response.baseRevisions),
          // The reviewed copies already hold the new schedule, so the item push delivers it. The user hears of
          // the refusal (components/RefusedReviews): the review itself never counts on the server.
          recordRefusal: (mutation, error) => {
            warn('Review was refused; its schedule will sync with the item:', error);
            const reviewed = latestItemsRef.current.find(item => item.data.id === mutation.event.itemId) ?? mutation.seedItem;
            recordRefusedReview(userId, {
              itemId: mutation.event.itemId,
              word: reviewed ? getItemTitle(reviewed) : mutation.event.itemId,
              reviewedAt: mutation.event.reviewedAt,
              reason: describeRefusedReview(error),
            });
          },
          remove: eventId => removePendingReviewMutation(userId, eventId),
          markUnsynced: markItemsUnsynced,
        });
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
  }, [userId, markItemsUnsynced, reconcileAppliedReview]);

  const undoSRSReview = useCallback(async (eventId: string): Promise<void> => {
    await flushPendingReviews();
    if (readPendingReviewMutations(userId).some(mutation => mutation.event.id === eventId)) {
      throw new Error(navigator.onLine ? 'This review is still syncing. Try undo again.' : 'Reconnect to undo this review.');
    }
    const response = await undoReviewMutation(eventId);
    await reconcileAppliedReview(response.items, response.baseRevisions);
    removeReview(eventId);
  }, [userId, flushPendingReviews, reconcileAppliedReview, removeReview]);

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

    // A deleted record isn't reviewed. A catalog sentence's comes back with the review, through its seed below,
    // in place of the deletion; anything else deleted stays so, and the review does nothing.
    const savedItem = latestItemsRef.current.find(i => i.data.id === itemId && !i.isDeleted);
    const requestedSeed = context?.seedItem;
    const catalogSeed = !savedItem && requestedSeed?.data.id === itemId && isCatalogProgressItem(requestedSeed)
      ? requestedSeed
      : undefined;
    const targetItem = savedItem ?? catalogSeed;
    if (!targetItem) return false;

    const targetTitle = getItemTitle(targetItem).toLowerCase().trim();
    const baseSRS = SRSAlgorithm.ensure(targetItem.srs, targetItem.data.id, targetItem.type);
    const updatedSRS = updateAfterRating(baseSRS, rating, now);
    // An item the server has never stored travels with its review as a seed (services/reviewOutbox).
    const seedItem = reviewSeed(targetItem, baseSRS, catalogSeed);
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
      await storeItemUpdates([reviewedItem]);
    } catch (e) {
      logError('💾 Failed to save SRS update to IndexedDB:', e);
    }

    await flushPendingReviews();
    return !readPendingReviewMutations(userId).some(mutation => mutation.event.id === reviewEvent.id);
  }, [userId, recordReview, updateItems, storeItemUpdates, flushPendingReviews]);

  return { reviewHistory, flushPendingReviews, undoSRSReview, updateSRS };
}
