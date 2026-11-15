const DAY_MS = 86_400_000;

const startOfLocalDay = (time: number): number => new Date(time).setHours(0, 0, 0, 0);

/**
 * When a sentence is next due, in calendar days on this device: 'today', 'tomorrow' or 'in Nd', or 'due' once the
 * time has come. Rounding the difference between the two local midnights absorbs a daylight-saving change.
 */
export function formatDueLabel(nextReview: number, now: number): string {
  if (nextReview <= now) return 'due';
  const days = Math.round((startOfLocalDay(nextReview) - startOfLocalDay(now)) / DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}
