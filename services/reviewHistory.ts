/**
 * How the study dashboard's review history is loaded: how far back a load takes reviews in full, and how a loaded
 * history joins what this device already holds. Plain functions, so node tests pin them; hooks/useReviewHistory.ts
 * runs them.
 */
import type { ReviewEvent, ReviewHistory } from '../types';

const DAY_MS = 86_400_000;
/** Reviews come in full for the week the dashboard's weekly numbers cover, plus a day. */
export const RECENT_DAYS = 8;

const byTime = (a: ReviewEvent, b: ReviewEvent) => a.reviewedAt - b.reviewedAt;

/**
 * Where a load's full reviews begin, `now` being when it starts: a week and a day back, or further, to the oldest
 * review still in the outbox (`pending`), so a review the outbox delivers meanwhile can't come back as an older
 * review as well.
 */
export function recentSinceFor(pending: readonly ReviewEvent[], now: number): number {
  let recentSince = now - RECENT_DAYS * DAY_MS;
  for (const event of pending) if (event.reviewedAt < recentSince) recentSince = event.reviewedAt;
  return recentSince;
}

/** The loaded history (`remote`) with every review `current` holds kept beside it, `current`'s copy winning. */
export function mergeLoadedHistory(current: ReviewHistory, remote: ReviewHistory): ReviewHistory {
  const recent = new Map(remote.recent.map(event => [event.id, event]));
  current.recent.forEach(event => recent.set(event.id, event));
  return { recent: [...recent.values()].sort(byTime), olderTimes: remote.olderTimes, olderCount: remote.olderCount };
}
