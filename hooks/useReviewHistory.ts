import { useCallback, useEffect, useState } from 'react';
import type { ReviewEvent } from '../types';
import { loadReviewHistory } from '../services/api/library';
import { warn } from '../services/logger';
import { readPendingReviewMutations } from '../services/reviewQueue';
import type { LoadedReviewHistory } from '../services/reviewHistory';

const EMPTY_HISTORY: LoadedReviewHistory = { recent: [], olderTimes: [], olderCount: 0, loaded: false };

const byTime = (a: ReviewEvent, b: ReviewEvent) => a.reviewedAt - b.reviewedAt;

/**
 * The signed-in user's review history: the server's, plus the reviews still in this device's outbox. It loads when
 * the user signs in, and again on coming back online or into view once the last load failed or is a quarter of an
 * hour old (services/reviewHistory.ts startHistoryLoads); `loaded` says whether a load has succeeded yet.
 */
export function useReviewHistory(userId?: string) {
  const [history, setHistory] = useState<LoadedReviewHistory>(EMPTY_HISTORY);

  useEffect(() => {
    if (!userId) { setHistory(EMPTY_HISTORY); return; }
    const pending = () =>
      [...new Map(readPendingReviewMutations(userId).map(mutation => [mutation.event.id, mutation.event])).values()];
    setHistory({ ...EMPTY_HISTORY, recent: pending().sort(byTime) });

    // The loads' rules stay out of the app's first chunk: they arrive with the first load, which waits on the
    // network anyway, and they're precached for an offline start.
    let stop: (() => void) | undefined;
    let cancelled = false;
    const onError = (error: unknown) => warn('Failed to load review history:', error);
    import('../services/reviewHistory')
      .then(({ startHistoryLoads }) => {
        if (cancelled) return;
        stop = startHistoryLoads({ pending, fetch: loadReviewHistory, update: setHistory, onError, online: window, page: document });
      })
      .catch(onError);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [userId]);

  /** Adds a review this device just made; the review outbox, not this history, delivers it. */
  const record = useCallback((event: ReviewEvent) => {
    setHistory(current => {
      const last = current.recent[current.recent.length - 1];
      // A new review normally belongs at the end, so it appends without re-sorting.
      const recent = !last || (event.reviewedAt >= last.reviewedAt && !current.recent.some(item => item.id === event.id))
        ? [...current.recent, event]
        : [...current.recent.filter(item => item.id !== event.id), event].sort(byTime);
      return { ...current, recent };
    });
  }, []);

  const remove = useCallback((eventId: string) => {
    setHistory(current => ({ ...current, recent: current.recent.filter(event => event.id !== eventId) }));
  }, []);

  return { reviewHistory: history, recordReview: record, removeReview: remove };
}
