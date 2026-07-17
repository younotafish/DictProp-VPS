import { useCallback, useEffect, useState } from 'react';
import type { ReviewEvent } from '../types';
import { loadReviewEvents, saveReviewEvent } from '../services/api';
import { warn } from '../services/logger';

export function useReviewHistory(userId?: string) {
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const pendingKey = userId ? `review_events_pending_${userId}` : '';

  const readPending = useCallback((): ReviewEvent[] => {
    if (!pendingKey) return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(pendingKey) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [pendingKey]);

  const writePending = useCallback((pending: ReviewEvent[]) => {
    if (!pendingKey) return;
    try {
      if (pending.length) localStorage.setItem(pendingKey, JSON.stringify(pending));
      else localStorage.removeItem(pendingKey);
    } catch { /* best effort */ }
  }, [pendingKey]);

  useEffect(() => {
    if (!userId) { setEvents([]); return; }
    const pending = readPending();
    loadReviewEvents(0)
      .then(async remote => {
        const merged = new Map(remote.map(event => [event.id, event]));
        pending.forEach(event => merged.set(event.id, event));
        setEvents([...merged.values()].sort((a, b) => a.reviewedAt - b.reviewedAt));
        const failed: ReviewEvent[] = [];
        for (const event of pending) {
          try { await saveReviewEvent(event); } catch { failed.push(event); }
        }
        writePending(failed);
      })
      .catch(error => warn('Failed to load review history:', error));
  }, [userId, readPending, writePending]);

  const record = useCallback((event: ReviewEvent) => {
    setEvents(current => [...current, event]);
    const pending = [...readPending().filter(item => item.id !== event.id), event];
    writePending(pending);
    saveReviewEvent(event).then(() => {
      writePending(readPending().filter(item => item.id !== event.id));
    }).catch(error => warn('Failed to persist review history:', error));
  }, [readPending, writePending]);

  return { reviewEvents: events, recordReview: record };
}
