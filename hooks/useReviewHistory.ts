import { useCallback, useEffect, useState } from 'react';
import type { ReviewEvent, ReviewHistory } from '../types';
import { loadReviewHistory, saveReviewEvent } from '../services/api';
import { warn } from '../services/logger';
import { readPendingReviewMutations } from '../services/reviewQueue';

const DAY = 24 * 60 * 60 * 1000;
/** Reviews come in full for the week the dashboard's weekly numbers cover, plus a day. */
const RECENT_DAYS = 8;
const EMPTY_HISTORY: ReviewHistory = { recent: [], olderTimes: [], olderCount: 0 };

const byTime = (a: ReviewEvent, b: ReviewEvent) => a.reviewedAt - b.reviewedAt;

/** Reviews saved before the review outbox existed, which may still be waiting to upload. */
function readLegacyPending(key: string): ReviewEvent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeLegacyPending(key: string, pending: ReviewEvent[]): void {
  try {
    if (pending.length) localStorage.setItem(key, JSON.stringify(pending));
    else localStorage.removeItem(key);
  } catch { /* best effort */ }
}

export function useReviewHistory(userId?: string) {
  const [history, setHistory] = useState<ReviewHistory>(EMPTY_HISTORY);

  useEffect(() => {
    if (!userId) { setHistory(EMPTY_HISTORY); return; }
    const legacyKey = `review_events_pending_${userId}`;
    const legacyPending = readLegacyPending(legacyKey);
    const unsynced = new Map(legacyPending.map(event => [event.id, event]));
    readPendingReviewMutations(userId).forEach(mutation => unsynced.set(mutation.event.id, mutation.event));
    setHistory({ ...EMPTY_HISTORY, recent: [...unsynced.values()].sort(byTime) });

    // The recent reviews reach back to the oldest unsynced one, so a review the outbox did deliver
    // can't come back as an older review as well.
    let recentSince = Date.now() - RECENT_DAYS * DAY;
    unsynced.forEach(event => { if (event.reviewedAt < recentSince) recentSince = event.reviewedAt; });
    let cancelled = false;
    loadReviewHistory(recentSince)
      .then(async remote => {
        if (cancelled) return;
        // Reviews recorded while the history loaded stay.
        setHistory(current => {
          const recent = new Map(remote.recent.map(event => [event.id, event]));
          current.recent.forEach(event => recent.set(event.id, event));
          return { recent: [...recent.values()].sort(byTime), olderTimes: remote.olderTimes, olderCount: remote.olderCount };
        });
        const failed: ReviewEvent[] = [];
        for (const event of legacyPending) {
          try { await saveReviewEvent(event); } catch { failed.push(event); }
        }
        writeLegacyPending(legacyKey, failed);
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
