import { stripSentenceMarkers } from '../../services/sentenceMarkers';
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

/** How many characters of the source sentence the context line shows on each side of the word. */
const CONTEXT_REACH = 40;

/**
 * The line above a result's meanings that shows the sentence it came from: "From your sentence: “…ran the gamut of
 * emotions…”", about 40 characters each side of the first place the word appears (or the sentence's start when it
 * doesn't), cut at word boundaries with an ellipsis where it's cut. Null without a sentence.
 */
export function contextLine(context: string | undefined, word: string): string | null {
  const text = stripSentenceMarkers(context ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const needle = word.trim().toLowerCase();
  const found = needle ? text.toLowerCase().indexOf(needle) : -1;
  const at = Math.max(0, found);
  const length = found < 0 ? 0 : needle.length;
  let start = Math.max(0, at - CONTEXT_REACH);
  let end = Math.min(text.length, at + length + (found < 0 ? 2 * CONTEXT_REACH : CONTEXT_REACH));
  // Never show part of a word at a cut edge.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > at + length) end = space;
  }
  return `From your sentence: “${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}”`;
}
