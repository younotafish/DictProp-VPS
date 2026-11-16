/**
 * How review timing reads: a rating's interval, the time until a card's next review, and the interval a schedule
 * sets. Plain functions, so the review rows, the popup and the card view's toasts don't load the study session.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A rating's interval, given in minutes: '10m', '2h', '3d'. */
export function formatReviewInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * How long until `timestamp`, in whole days, else hours, else minutes ('3d', '5h', '12m'); 'now' once it is
 * under a minute away or past. Review rows show 'due' for a past review before asking.
 */
export function formatTimeUntil(timestamp: number, now: number): string {
  const diff = timestamp - now;
  if (diff <= 0) return 'now';
  const minutes = Math.floor(diff / MINUTE_MS), hours = Math.floor(diff / HOUR_MS), days = Math.floor(diff / DAY_MS);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
}

/** The interval a schedule just set, in whole days and at least one: from `now` to its `nextReview`. */
export function reviewIntervalDays(nextReview: number, now: number): number {
  return Math.max(1, Math.round((nextReview - now) / DAY_MS));
}
