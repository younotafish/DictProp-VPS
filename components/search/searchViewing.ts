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
 * The open result, found by its entry's id, and its position among the ready results; null once it's no longer
 * among them. Ready results keep the order they were asked for, so an earlier lookup finishing moves the open one's
 * position but not which result is open.
 */
export function resolveViewing(readyItems: readonly QueueItem[], viewingId: string | null): { index: number; item: QueueItem } | null {
  const index = viewingId === null ? -1 : readyItems.findIndex(item => item.id === viewingId);
  return index < 0 ? null : { index, item: readyItems[index] };
}

/**
 * The result the sheet shows once the open result `dismissedId` is dismissed: the next ready result, or the previous
 * one when it was the last; null when no other result is ready, so the sheet closes.
 */
export function neighbourAfterDismiss(readyItems: readonly QueueItem[], dismissedId: string): string | null {
  const index = readyItems.findIndex(item => item.id === dismissedId);
  if (index < 0) return null;
  return (readyItems[index + 1] ?? readyItems[index - 1])?.id ?? null;
}

/** The meaning to show for `index` among `count`: the last one when the result has fewer meanings, and 0 for none. */
export const clampMeaning = (index: number, count: number): number => Math.max(0, Math.min(index, count - 1));

/**
 * The meaning to show once the entry `refreshedId` has its fresh result: the first, when that entry is the open result
 * (the fresh result may have fewer meanings), and otherwise the meaning already shown, since the open result is
 * another one.
 */
export function meaningAfterRefresh(openId: string | undefined, refreshedId: string, meaningIndex: number): number {
  return openId === refreshedId ? 0 : meaningIndex;
}
