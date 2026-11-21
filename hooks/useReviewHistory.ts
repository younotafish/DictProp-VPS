import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewEvent } from '../types';
import { loadReviewHistory } from '../services/api/library';
import { warn } from '../services/logger';
import { readPendingReviewMutations } from '../services/reviewQueue';
import type { HistoryLoads, LoadedReviewHistory } from '../services/reviewHistory';

const EMPTY_HISTORY: LoadedReviewHistory = { recent: [], olderTimes: [], olderCount: 0, loaded: false };

/**
 * How old the history may be when Today shows it, or keeps it on screen, before it loads again (refreshReviewHistory),
 * so the goal and the streak take in the units another device finished.
 */
export const SHOWN_HISTORY_MAX_AGE_MS = 60_000;

const byTime = (a: ReviewEvent, b: ReviewEvent) => a.reviewedAt - b.reviewedAt;

/**
 * The signed-in user's review history: the server's, plus the reviews still in this device's outbox. It loads when
 * the user signs in, again on coming back online or into view once the last load failed or is a quarter of an hour old
 * (services/reviewHistory.ts startHistoryLoads), and as Today asks, once it is over a minute old (refreshReviewHistory);
 * `loaded` says whether a load has succeeded yet.
 */
export function useReviewHistory(userId?: string) {
  const [history, setHistory] = useState<LoadedReviewHistory>(EMPTY_HISTORY);
  const loadsRef = useRef<HistoryLoads | null>(null);

  useEffect(() => {
    if (!userId) { setHistory(EMPTY_HISTORY); return; }
    const pending = () =>
      [...new Map(readPendingReviewMutations(userId).map(mutation => [mutation.event.id, mutation.event])).values()];
    setHistory({ ...EMPTY_HISTORY, recent: pending().sort(byTime) });

    // The loads' rules stay out of the app's first chunk (only their types are imported above): they arrive with the
    // first load, which waits on the network anyway, and they're precached for an offline start.
    let loads: HistoryLoads | undefined;
    let cancelled = false;
    const onError = (error: unknown) => warn('Failed to load review history:', error);
    import('../services/reviewHistory')
      .then(({ startHistoryLoads }) => {
        if (cancelled) return;
        loads = startHistoryLoads({ pending, fetch: loadReviewHistory, update: setHistory, onError, online: window, page: document });
        loadsRef.current = loads;
      })
      .catch(onError);
    return () => {
      cancelled = true;
      loads?.stop();
      if (loadsRef.current === loads) loadsRef.current = null;
    };
  }, [userId]);

  /**
   * Loads the history again when the last load failed or is more than a minute old, and no load is under way; before
   * the first load has started, or after sign-out, it does nothing. Stable, so a screen's effects can depend on it.
   */
  const refresh = useCallback(() => loadsRef.current?.refresh(SHOWN_HISTORY_MAX_AGE_MS), []);

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

  /** Takes out a review that no longer counts: one undone, or one the server refused, which it never stored. */
  const remove = useCallback((eventId: string) => {
    setHistory(current => ({ ...current, recent: current.recent.filter(event => event.id !== eventId) }));
  }, []);

  return { reviewHistory: history, recordReview: record, removeReview: remove, refreshReviewHistory: refresh };
}
