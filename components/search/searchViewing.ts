import type { QueueItem } from './searchQueue';

/** What the search shows: only the floating button, the search box, or the results sheet. */
export type SearchMode = 'idle' | 'input' | 'viewing';

/**
 * The meaning `delta` steps away from `index` among `count`, or null when there's nowhere to go: one meaning
 * or none, or the first one when stepping back without `wrap`. With `wrap`, stepping past either end comes
 * round to the other.
 */
export function stepMeaning(index: number, count: number, delta: 1 | -1, wrap: boolean): number | null {
  if (count <= 1) return null;
  if (delta === 1) return (index + 1) % count;
  if (index > 0) return index - 1;
  return wrap ? count - 1 : null;
}

/**
 * The open result's index once `dismissedId` leaves the queue: the same position, or the last ready result when
 * that position is gone; null when no ready result is left, so the sheet closes.
 */
export function viewingIndexAfterDismiss(queue: readonly QueueItem[], dismissedId: string, viewingIndex: number): number | null {
  const remaining = queue.filter(item => item.id !== dismissedId && item.status === 'ready').length;
  return remaining === 0 ? null : Math.min(viewingIndex, remaining - 1);
}
