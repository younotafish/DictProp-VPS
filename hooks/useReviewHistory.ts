import { useCallback, useEffect, useState } from 'react';
import type { ReviewEvent, ReviewHistory } from '../types';
import { loadReviewHistory } from '../services/api/library';
import { warn } from '../services/logger';
import { mergeLoadedHistory, recentSinceFor } from '../services/reviewHistory';
import { readPendingReviewMutations } from '../services/reviewQueue';

const EMPTY_HISTORY: ReviewHistory = { recent: [], olderTimes: [], olderCount: 0 };

const byTime = (a: ReviewEvent, b: ReviewEvent) => a.reviewedAt - b.reviewedAt;

/** The signed-in user's review history: the server's, plus the reviews still in this device's outbox. */
export function useReviewHistory(userId?: string) {
  const [history, setHistory] = useState<ReviewHistory>(EMPTY_HISTORY);

  useEffect(() => {
    if (!userId) { setHistory(EMPTY_HISTORY); return; }
    const unsynced = new Map(readPendingReviewMutations(userId).map(mutation => [mutation.event.id, mutation.event]));
    setHistory({ ...EMPTY_HISTORY, recent: [...unsynced.values()].sort(byTime) });

    let cancelled = false;
    loadReviewHistory(recentSinceFor([...unsynced.values()], Date.now()))
      .then(remote => {
        if (cancelled) return;
        // Reviews recorded while the history loaded stay.
        setHistory(current => mergeLoadedHistory(current, remote));
      })
      .catch(error => warn('Failed to load review history:', error));
    return () => { cancelled = true; };
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
